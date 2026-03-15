document.addEventListener('DOMContentLoaded', () => {
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
    let stopRequested = false;

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

        // Turnstile validate
        const turnstileResponse = document.querySelector('[name="cf-turnstile-response"]')?.value;
        if (!turnstileResponse) {
            alert('Please complete the spam protection check.');
            return;
        }
        
        const emailVal = dashboardEmail.value.trim();
        const appPasswordVal = dashboardPassword.value.trim();

        sendBtn.disabled = true;
        sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

        try {
            // Verify credentials first
            const verifyPayload = { 
                email: emailVal, 
                appPassword: appPasswordVal,
                cfToken: turnstileResponse 
            };
            
            const verifyResponse = await fetch('/api/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(verifyPayload)
            });
            const verifyResult = await verifyResponse.json();
            
            if (!verifyResult.success) {
                alert(verifyResult.message || 'Invalid credentials or spam check failed.');
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
                try { turnstile.reset(); } catch(e){} // reset captcha on fail
                return;
            }

            // Start sending batches
            startSendingUI(extractedEmails.length);
            
            // Loop and chunk emails to prevent server timeouts
            // Chunk size of 3 means the worker will only process 3 at a time in the background.
            // Adjust chunk size if Worker has large CPU limits, 3 is very safe.
            const chunkSize = 3; 
            let sentCount = 0;
            let failedCount = 0;
            
            for (let i = 0; i < extractedEmails.length; i += chunkSize) {
                if (stopRequested) break;
                
                const chunk = extractedEmails.slice(i, i + chunkSize);
                
                // Show current status
                updateProgressUI(sentCount, failedCount, extractedEmails.length, `Sending to batch ${Math.floor(i/chunkSize) + 1}...`);
                
                try {
                    const payload = {
                        email: emailVal,
                        appPassword: appPasswordVal,
                        senderName: senderName.value.trim(),
                        subject: subject.value.trim(),
                        messageBody: messageBody.value.trim(),
                        recipients: chunk,
                        cfToken: turnstileResponse // reuse token or require fresh one (backend might require bypass once verified)
                    };

                    const response = await fetch('/api/send-batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    const result = await response.json();
                    
                    if (result.success) {
                        sentCount += result.results.sent;
                        failedCount += result.results.failed;
                    } else {
                        failedCount += chunk.length;
                    }

                } catch (err) {
                    console.error('Batch failed:', err);
                    failedCount += chunk.length;
                }
                
                // Update final progress for this batch
                updateProgressUI(sentCount, failedCount, extractedEmails.length);
                
                // Small artificial delay to respect rate limits
                await new Promise(res => setTimeout(res, 1000));
            }
            
            isSending = false;
            if (stopRequested) {
                statusIcon.className = 'fa-solid fa-circle-stop text-danger';
                statusText.textContent = 'Stopped by user.';
            } else {
                statusIcon.className = 'fa-solid fa-circle-check text-success';
                statusText.textContent = 'Completed successfully!';
            }
            finishSendingUI();
            
        } catch (error) {
            console.error('Send error:', error);
            alert('Failed to connect to server.');
            isSending = false;
            finishSendingUI();
        } finally {
            if (!isSending) {
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
            }
            try { turnstile.reset(); } catch(e){} // Reset token when done
        }
    });

    // Handle Stop
    stopBtn.addEventListener('click', () => {
        stopRequested = true;
        statusIcon.className = 'fa-solid fa-spinner fa-spin text-warning';
        statusText.textContent = 'Stopping... waiting for current batch...';
        stopBtn.disabled = true;
    });

    // Helper functions
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
        stopRequested = false;
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

    function updateProgressUI(sentCount, failedCount, total, customText) {
        statSent.textContent = sentCount;
        statFailed.textContent = failedCount;
        
        const remaining = total - (sentCount + failedCount);
        statRemaining.textContent = remaining;

        const percentage = Math.round(((sentCount + failedCount) / total) * 100);
        progressBar.style.width = `${percentage}%`;

        if (customText && isSending && !stopRequested) {
            statusText.textContent = customText;
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
