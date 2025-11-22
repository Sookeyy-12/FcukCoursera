document.getElementById('startBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('startBtn').disabled = true;
    document.getElementById('status').innerText = "Starting...";

    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    // Send message to content script to start
    chrome.tabs.sendMessage(tab.id, { action: "start_skipping" }, (response) => {
        if (chrome.runtime.lastError) {
            document.getElementById('status').innerText = "Error: Refresh page & try again.";
        } else {
            console.log("Process started");
        }
    });
});

document.getElementById('readBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('readBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Readings...";

    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    // Send message to content script to start
    chrome.tabs.sendMessage(tab.id, { action: "start_reading_completion" }, (response) => {
        if (chrome.runtime.lastError) {
            document.getElementById('status').innerText = "Error: Refresh page & try again.";
        } else {
            console.log("Reading process started");
        }
    });
});

// Load saved key
chrome.storage.local.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey) {
        document.getElementById('apiKey').value = result.geminiApiKey;
    }
});

// Check for running process on load
(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes("coursera.org")) {
        chrome.tabs.sendMessage(tab.id, { action: "get_status" }, (response) => {
            if (chrome.runtime.lastError) return; // Content script might not be ready
            
            if (response && response.isRunning) {
                // Restore UI state
                document.getElementById('startBtn').disabled = true;
                document.getElementById('readBtn').disabled = true;
                document.getElementById('quizBtn').disabled = true;
                document.getElementById('completeBtn').disabled = true;
                
                document.getElementById('status').innerText = response.statusMessage;
                
                // Restore logs
                const logDiv = document.getElementById('log');
                response.logs.forEach(msg => {
                    const entry = document.createElement('div');
                    entry.innerText = msg;
                    logDiv.appendChild(entry);
                });
                logDiv.scrollTop = logDiv.scrollHeight;

                // Restore progress bar if applicable
                if (response.isRunning) {
                    document.getElementById('progressContainer').style.display = 'block';
                    document.getElementById('progressText').style.display = 'block';
                    
                    if (response.progress && response.progress.total > 0) {
                        const { current, total, message } = response.progress;
                        const percentage = Math.round((current / total) * 100);
                        document.getElementById('progressBar').style.width = percentage + '%';
                        document.getElementById('progressText').innerText = `${percentage}% - ${message}`;
                    } else {
                        // Initializing state
                        document.getElementById('progressBar').style.width = '0%';
                        document.getElementById('progressText').innerText = "Initializing...";
                    }
                }
            }
        });
    }
})();

document.getElementById('quizBtn').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value;
    if (!apiKey) {
        document.getElementById('status').innerText = "Enter API Key first!";
        return;
    }
    chrome.storage.local.set({ geminiApiKey: apiKey });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('quizBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Quiz Solver...";

    chrome.tabs.sendMessage(tab.id, { action: "start_quiz_solver", apiKey: apiKey }, (response) => {
        if (chrome.runtime.lastError) {
            document.getElementById('status').innerText = "Error: Refresh page & try again.";
        } else {
            console.log("Quiz solver started");
        }
    });
});

document.getElementById('completeBtn').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value;
    if (!apiKey) {
        alert("Please enter a Gemini API Key first.");
        return;
    }
    
    // Save key
    chrome.storage.local.set({ geminiApiKey: apiKey });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('completeBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Course Completion...";
    
    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    chrome.tabs.sendMessage(tab.id, { action: "start_complete_course", apiKey: apiKey }, (response) => {
        if (chrome.runtime.lastError) {
            document.getElementById('status').innerText = "Error: Refresh page & try again.";
        } else {
            console.log("Course completion started");
        }
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "log") {
        const logDiv = document.getElementById('log');
        const entry = document.createElement('div');
        entry.innerText = request.data;
        logDiv.appendChild(entry);
        logDiv.scrollTop = logDiv.scrollHeight;
    }
    if (request.action === "status") {
        document.getElementById('status').innerText = request.data;
    }
    if (request.action === "progress_update") {
        const { current, total, message } = request.data;
        
        // Auto-show progress bar if we get an update
        document.getElementById('progressContainer').style.display = 'block';
        document.getElementById('progressText').style.display = 'block';

        let percentage = 0;
        if (total > 0) {
            percentage = Math.round((current / total) * 100);
        }
        
        document.getElementById('progressBar').style.width = percentage + '%';
        document.getElementById('progressText').innerText = `${percentage}% - ${message}`;
    }
    if (request.action === "finished") {
        document.getElementById('startBtn').disabled = false;
        document.getElementById('readBtn').disabled = false;
        document.getElementById('quizBtn').disabled = false;
        document.getElementById('completeBtn').disabled = false;
        document.getElementById('status').innerText = "Process Finished!";
    }
});
