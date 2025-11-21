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
    if (request.action === "start_reading_completion") {
        startReadingCompletionProcess();
        sendResponse({ status: "started" });
    }
});

async function startSkippingProcess() {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        log(`Queued ${allItems.length} items for checking...`);

        // 4. Iterate and Complete
        let completedCount = 0;
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            updateStatus(`[${i + 1}/${allItems.length}] ${item.moduleName}: ${item.name}`);
            
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

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
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

async function getCourseData() {
    log("Initializing...");
    
    // 1. Get Course Slug from URL
    const urlParts = window.location.pathname.split('/').filter(p => p);
    const learnIndex = urlParts.indexOf('learn');
    if (learnIndex === -1 || urlParts.length <= learnIndex + 1) {
        throw new Error("Could not find course slug in URL. Go to course home.");
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
        throw new Error("Error fetching User/Course IDs: " + e.message);
    }

    // 3. Fetch Course Syllabus
    log("Fetching course syllabus...");
    let allItems = [];
    try {
        // Removed fields parameter to get full object details including typeName
        const syllabusUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=modules,lessons,items`;
        const syllabusResp = await fetch(syllabusUrl, {credentials: "include"});
        const syllabusData = await syllabusResp.json();
        
        if (!syllabusData.linked) {
             throw new Error("'linked' property missing.");
        }

        const items = syllabusData.linked["onDemandCourseMaterialItems.v2"] || [];
        const modules = syllabusData.linked["onDemandCourseMaterialModules.v1"] || [];
        
        const moduleMap = {};
        modules.forEach(m => { moduleMap[m.id] = m.name; });

        log(`Total items found: ${items.length} across ${modules.length} modules.`);
        
        // if (items.length > 0) {
        //    log("First Item Sample: " + JSON.stringify(items[0]));
        // }

        allItems = items.map(item => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            typeName: item.typeName || item.contentSummary?.typeName,
            moduleId: item.moduleId,
            moduleName: moduleMap[item.moduleId] || "Unknown Module"
        }));

    } catch (e) {
        throw new Error("Error fetching syllabus: " + e.message);
    }

    return { userId, courseId, courseSlug, allItems };
}

async function startReadingCompletionProcess() {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        // Filter for readings if typeName is available
        let readingItems = allItems.filter(item => item.typeName === 'supplement');
        
        if (readingItems.length === 0) {
            log("No explicit 'supplement' types found. Checking all items...");
            readingItems = allItems;
        } else {
            log(`Found ${readingItems.length} readings.`);
        }

        let completedCount = 0;
        for (let i = 0; i < readingItems.length; i++) {
            const item = readingItems[i];
            updateStatus(`[${i + 1}/${readingItems.length}] Checking: ${item.name}`);
            
            try {
                const result = await completeSingleReading(userId, courseId, courseSlug, item.id);
                if (result) {
                    log(`[Reading Completed] ${item.name}`);
                    completedCount++;
                    // Small delay to avoid rate limits
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (e) {
                log(`[Error] ${item.name}: ${e.message}`);
            }
        }

        updateStatus(`Done! Completed ${completedCount} readings.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

async function completeSingleReading(userId, courseId, courseSlug, itemId) {
    try {
        // 1. Check if it is a supplement (reading)
        const checkUrl = `https://www.coursera.org/api/onDemandSupplements.v1/${courseId}~${itemId}`;
        const checkResp = await fetch(checkUrl, { method: 'GET', credentials: 'include' });
        
        if (!checkResp.ok) {
            return false; 
        }

        const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
        const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
        
        const headers = {
            'Content-Type': 'application/json',
            'x-csrf3-token': csrfToken,
            'x-coursera-application': 'ondemand',
            'x-requested-with': 'XMLHttpRequest',
        };

        const completionId = `${userId}~${courseId}~${itemId}`;
        const resourceUrl = `https://www.coursera.org/api/onDemandSupplementCompletions.v1/${completionId}`;
        const collectionUrl = `https://www.coursera.org/api/onDemandSupplementCompletions.v1`;

        // Strategy 1: POST to collection with userId as Number
        // This is the most common pattern for creating a new completion record
        try {
            const body = JSON.stringify({
                courseId: courseId,
                itemId: itemId,
                userId: Number(userId)
            });
            const res = await fetch(collectionUrl, { method: 'POST', headers, body, credentials: 'include' });
            if (res.ok) return true;
            // log(`Strategy 1 failed: ${res.status}`);
        } catch(e) {}

        // Strategy 2: PUT to resource with composite ID and userId as Number
        try {
            const body = JSON.stringify({
                id: completionId,
                courseId: courseId,
                itemId: itemId,
                userId: Number(userId)
            });
            const res = await fetch(resourceUrl, { method: 'PUT', headers, body, credentials: 'include' });
            if (res.ok) return true;
            // log(`Strategy 2 failed: ${res.status}`);
        } catch(e) {}

        // Strategy 3: PUT to resource with just ID (minimal update)
        try {
            const body = JSON.stringify({
                id: completionId
            });
            const res = await fetch(resourceUrl, { method: 'PUT', headers, body, credentials: 'include' });
            if (res.ok) return true;
        } catch(e) {}

        return false;
    } catch (e) {
        log(`Error completing reading: ${e.message}`);
        return false;
    }
}
