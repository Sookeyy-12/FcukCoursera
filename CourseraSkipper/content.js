// Helper to log to popup
function log(msg) {
    console.log("[Skipper]", msg);
    chrome.runtime.sendMessage({ action: "log", data: msg }).catch(() => {});
}

function updateStatus(msg) {
    chrome.runtime.sendMessage({ action: "status", data: msg }).catch(() => {});
}

// Main Logic
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_skipping") {
        startSkippingProcess();
        sendResponse({ status: "started" });
    }
});

async function startSkippingProcess() {
    log("Initializing...");
    
    // 1. Get Course Slug from URL
    // URL format usually: https://www.coursera.org/learn/COURSE_SLUG/home/...
    const urlParts = window.location.pathname.split('/').filter(p => p);
    const learnIndex = urlParts.indexOf('learn');
    if (learnIndex === -1 || urlParts.length <= learnIndex + 1) {
        log("Error: Could not find course slug in URL. Go to course home.");
        return;
    }
    const courseSlug = urlParts[learnIndex + 1];
    log(`Course Slug: ${courseSlug}`);

    // 2. Get User ID and Course ID
    let userId, courseId;
    try {
        const userResp = await fetch("https://www.coursera.org/api/adminUserPermissions.v1?q=my", {credentials: "include"});
        const userData = await userResp.json();
        userId = userData.elements?.[0]?.id;

        const courseResp = await fetch(`https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=tracks`, {credentials: "include"});
        const courseData = await courseResp.json();
        courseId = courseData.elements?.[0]?.id;
        
        if (!userId || !courseId) throw new Error("Missing IDs");
        log(`User ID: ${userId}, Course ID: ${courseId}`);
    } catch (e) {
        log("Error fetching User/Course IDs: " + e.message);
        return;
    }

    // 3. Fetch Course Syllabus to find all Videos
    log("Fetching course syllabus...");
    let videoItems = [];
    try {
        // Fetching all modules and items - requesting specific fields to ensure we get type info
        const syllabusUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=modules,lessons,items&fields=name,contentSummary,typeName`;
        const syllabusResp = await fetch(syllabusUrl, {credentials: "include"});
        const syllabusData = await syllabusResp.json();
        
        if (!syllabusData.linked) {
             log("Error: 'linked' property missing.");
             return;
        }

        log("Linked Keys: " + Object.keys(syllabusData.linked).join(", "));

        const items = syllabusData.linked["onDemandCourseMaterialItems.v2"] || [];
        const modules = syllabusData.linked["onDemandCourseMaterialModules.v1"] || [];
        
        // Create a map of Module ID -> Module Name for better logging
        const moduleMap = {};
        modules.forEach(m => { moduleMap[m.id] = m.name; });

        log(`Total items found: ${items.length} across ${modules.length} modules.`);
        
        // Since we can't reliably filter by type from the syllabus, we will try to process ALL items.
        // The completeSingleVideo function will check if the item is actually a video.
        videoItems = items.map(item => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            moduleId: item.moduleId,
            moduleName: moduleMap[item.moduleId] || "Unknown Module"
        }));

        log(`Queued ${videoItems.length} items for checking...`);

    } catch (e) {
        log("Error fetching syllabus: " + e.message);
        return;
    }

    // 4. Iterate and Complete
    let completedCount = 0;
    for (let i = 0; i < videoItems.length; i++) {
        const item = videoItems[i];
        updateStatus(`[${i + 1}/${videoItems.length}] ${item.moduleName}: ${item.name}`);
        
        try {
            const result = await completeSingleVideo(userId, courseId, courseSlug, item.id);
            if (result) {
                log(`[Video Completed] ${item.name} (${item.moduleName})`);
                completedCount++;
                // Reduced delay after a successful video completion to speed up processing
                await new Promise(r => setTimeout(r, 500));
            } else {
                // It wasn't a video, or failed silently
                // log(`[Skipped] ${item.name} (Not a video)`);
                // Short delay to not hammer API
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            log(`[Error] ${item.name}: ${e.message}`);
        }
    }

    updateStatus(`Done! Completed ${completedCount} videos.`);
    chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});
}

/**
 * Core logic adapted from your script to complete a single video by Item ID
 * Returns true if it was a video and completed successfully, false otherwise.
 */
async function completeSingleVideo(userId, courseId, courseSlug, itemId) {
    // A. Get Video Metadata (Tracking ID & Duration)
    let timeCommitment = 1800000; // Hardcoded to 30 minutes
    let trackingId = null;

    try {
        const videoMetadataUrl = `https://www.coursera.org/api/onDemandLectureVideos.v1/${courseId}~${itemId}?includes=video&fields=disableSkippingForward,startMs,endMs`;
        const metaResp = await fetch(videoMetadataUrl, {credentials: "include"});
        
        // If 404 or other error, it's likely not a video (e.g. reading, quiz)
        if (!metaResp.ok) return false;

        const metaData = await metaResp.json();
        const videoElement = metaData.linked?.["onDemandVideos.v1"]?.[0];
        
        if (videoElement) {
            trackingId = videoElement.id;
        } else {
            return false; // Not a video
        }
    } catch (e) {
        return false; // Failed to fetch metadata, assume not a video
    }

    if (!trackingId) {
        return false;
    }

    // B. Execute Completion Sequence
    const apiUrlBase = `https://www.coursera.org/api/opencourse.v1/user/${userId}/course/${courseSlug}/item/${itemId}/lecture/videoEvents/`;
    const progressUrl = `https://www.coursera.org/api/onDemandVideoProgresses.v1/${userId}~${courseId}~${trackingId}`;

    const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
    
    const headers = {
        'Content-Type': 'application/json',
        'x-csrf3-token': csrfToken,
        'x-coursera-application': 'ondemand',
        'x-requested-with': 'XMLHttpRequest',
    };
    const payload = JSON.stringify({ contentRequestBody: {} });

    // 1. Play
    await fetch(apiUrlBase + 'play?autoEnroll=false', {
        method: 'POST', headers: headers, body: payload, credentials: 'include'
    });

    // 2. Update Progress
    const progressPayload = JSON.stringify({
        videoProgressId: `${userId}~${courseId}~${trackingId}`,
        viewedUpTo: timeCommitment 
    });
    await fetch(progressUrl, {
        method: 'PUT', headers: headers, body: progressPayload, credentials: 'include'
    });

    // Wait a bit for server validation
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. End
    const endResp = await fetch(apiUrlBase + 'ended?autoEnroll=false', {
        method: 'POST', headers: headers, body: payload, credentials: 'include'
    });

    if (endResp.status !== 200 && endResp.status !== 204) {
        throw new Error(`End event failed: ${endResp.status}`);
    }

    return true;
}
