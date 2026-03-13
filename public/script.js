document.addEventListener('DOMContentLoaded', () => {
    // Connect Socket.IO
    const socket = io();
    let clientSocketId = null;

    socket.on('connected', (data) => {
        clientSocketId = data.socketId;
        console.log('Connected with Socket ID:', clientSocketId);
    });

    // --- DOM Elements ---

    // Dashboard Items
    const dashboardEmail = document.getElementById('dashboard-email');
    const dashboardPassword = document.getElementById('dashboard-password');
    const togglePasswordBtn = document.getElementById('toggle-password');
    
    // Compose Form
    const senderName = document.getElementById('sender-name');
    const subject = document.getElementById('subject');
    const messageBody = document.getElementById('message-body');
    
    // Recipients
    const recipientsInput = document.getElementById('recipients-input');
    const detectedCount = document.getElementById('detected-count');
    const emailValidationError = document.getElementById('email-validation-error');
    
    // Progress Monitor
    const statTotal = document.getElementById('stat-total');
    const statSent = document.getElementById('stat-sent');
    const statFailed = document.getElementById('stat-failed');
    const statRemaining = document.getElementById('stat-remaining');
    const progressBar = document.getElementById('progress-bar');
    const statusIcon = document.getElementById('status-icon');
    const statusText = document.getElementById('status-text');
    
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');

    // State 
    let extractedEmails = [];
    let isSending = false;

    // --- Events --- //

    // Toggle Password Visibility
    togglePasswordBtn.addEventListener('click', () => {
        const type = dashboardPassword.getAttribute('type') === 'password' ? 'text' : 'password';
        dashboardPassword.setAttribute('type', type);
        togglePasswordBtn.innerHTML = type === 'password' ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
    });

    // Process pasted emails
    recipientsInput.addEventListener('input', extractEmails);
    
    function extractEmails() {
        const text = recipientsInput.value;
        if (!text.trim()) {
            extractedEmails = [];
            detectedCount.textContent = '0 found';
            return;
        }

        // Regex to find multiple emails
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
        const matches = text.match(emailRegex) || [];
        
        // Remove duplicates & lowercase
        extractedEmails = [...new Set(matches.map(e => e.toLowerCase()))];
        
        detectedCount.textContent = `${extractedEmails.length} found`;
        
        if (extractedEmails.length > 0) {
            emailValidationError.classList.add('hidden');
        }
    }

    // Handle Send
    sendBtn.addEventListener('click', async () => {
        if (isSending) return;

        // Validate
        if (!dashboardEmail.value.trim()) return alert('Please enter your Gmail.');
        if (!dashboardPassword.value.trim()) return alert('Please enter your App Password.');
        if (!senderName.value.trim()) return alert('Please enter a Sender Name.');
        if (!subject.value.trim()) return alert('Please enter a Subject.');
        if (!messageBody.value.trim()) return alert('Please enter a Message Body.');
        if (extractedEmails.length === 0) {
            emailValidationError.classList.remove('hidden');
            return;
        }
        
        const emailVal = dashboardEmail.value.trim();
        const appPasswordVal = dashboardPassword.value.trim();

        sendBtn.disabled = true;
        sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

        try {
            // Verify credentials first
            const verifyResponse = await fetch('/api/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: emailVal, appPassword: appPasswordVal })
            });
            const verifyResult = await verifyResponse.json();
            
            if (!verifyResult.success) {
                alert(verifyResult.message || 'Invalid credentials');
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
                return;
            }

            const payload = {
                socketId: clientSocketId,
                email: emailVal,
                appPassword: appPasswordVal,
                senderName: senderName.value.trim(),
                subject: subject.value.trim(),
                messageBody: messageBody.value.trim(),
                recipients: extractedEmails
            };

            const response = await fetch('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            
            if (result.success) {
                startSendingUI(extractedEmails.length);
            } else {
                alert(result.message || 'Failed to start sending.');
            }
        } catch (error) {
            console.error('Send error:', error);
            alert('Failed to connect to server.');
        } finally {
            if (!isSending) {
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
            }
        }
    });

    // Handle Stop
    stopBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ socketId: clientSocketId })
            });
            
            statusIcon.className = 'fa-solid fa-spinner fa-spin text-warning';
            statusText.textContent = 'Stopping...';
            stopBtn.disabled = true;
        } catch (error) {
            console.error('Stop error:', error);
        }
    });

    // Socket Events (Progress Tracking)
    socket.on('progress', (data) => {
        if (!isSending) return;
        updateProgressUI(data.sentCount, data.failedCount, data.total, data.currentEmail);
    });

    socket.on('complete', (data) => {
        isSending = false;
        updateProgressUI(data.sentCount, data.failedCount, data.total);
        statusIcon.className = 'fa-solid fa-circle-check text-success';
        statusText.textContent = 'Completed successfully!';
        finishSendingUI();
    });

    socket.on('stopped', (data) => {
        isSending = false;
        updateProgressUI(data.sentCount, data.failedCount, data.total);
        statusIcon.className = 'fa-solid fa-circle-stop text-danger';
        statusText.textContent = 'Stopped by user.';
        finishSendingUI();
    });

    // Helper functions
    function resetDashboard() {
        dashboardEmail.value = '';
        dashboardPassword.value = '';
        senderName.value = '';
        subject.value = '';
        messageBody.value = '';
        recipientsInput.value = '';
        extractedEmails = [];
        detectedCount.textContent = '0 found';
        emailValidationError.classList.add('hidden');
        resetProgressUI();
    }

    function resetProgressUI() {
        statTotal.textContent = '0';
        statSent.textContent = '0';
        statFailed.textContent = '0';
        statRemaining.textContent = '0';
        progressBar.style.width = '0%';
        statusIcon.className = 'fa-solid fa-circle-pause text-muted';
        statusText.textContent = 'Ready to send';
    }

    function startSendingUI(total) {
        isSending = true;
        statTotal.textContent = total;
        statSent.textContent = '0';
        statFailed.textContent = '0';
        statRemaining.textContent = total;
        progressBar.style.width = '0%';
        
        statusIcon.className = 'fa-solid fa-circle-notch fa-spin text-primary';
        statusText.textContent = 'Sending emails...';

        sendBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        stopBtn.disabled = false;
        
        // Disable inputs
        setInputState(true);
    }

    function updateProgressUI(sentCount, failedCount, total, currentEmail) {
        statSent.textContent = sentCount;
        statFailed.textContent = failedCount;
        
        const remaining = total - (sentCount + failedCount);
        statRemaining.textContent = remaining;

        const percentage = Math.round(((sentCount + failedCount) / total) * 100);
        progressBar.style.width = `${percentage}%`;

        if (currentEmail && isSending) {
            statusText.textContent = `Sending to: ${currentEmail}`;
        }
    }

    function finishSendingUI() {
        sendBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        setInputState(false);
    }

    function setInputState(disabled) {
        dashboardEmail.disabled = disabled;
        dashboardPassword.disabled = disabled;
        senderName.disabled = disabled;
        subject.disabled = disabled;
        messageBody.disabled = disabled;
        recipientsInput.disabled = disabled;
    }
});
