document.getElementById('startBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('startBtn').disabled = true;
    document.getElementById('status').innerText = "Starting...";

    // Send message to content script to start
    chrome.tabs.sendMessage(tab.id, { action: "start_skipping" }, (response) => {
        if (chrome.runtime.lastError) {
            document.getElementById('status').innerText = "Error: Refresh page & try again.";
        } else {
            console.log("Process started");
        }
    });
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "log") {
        const logDiv = document.getElementById('log');
        const entry = document.createElement('div');
        entry.innerText = message.data;
        logDiv.appendChild(entry);
        logDiv.scrollTop = logDiv.scrollHeight;
    }
    if (message.action === "status") {
        document.getElementById('status').innerText = message.data;
    }
    if (message.action === "finished") {
        document.getElementById('startBtn').disabled = false;
        document.getElementById('status').innerText = "Done!";
    }
});
