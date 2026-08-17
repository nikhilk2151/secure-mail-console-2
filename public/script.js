document.addEventListener('DOMContentLoaded', () => {

    // ==================== PASSWORD GATE ====================
    const passwordGate = document.getElementById('password-gate');
    const mainApp = document.getElementById('main-app');
    const gateForm = document.getElementById('gate-form');
    const gatePassword = document.getElementById('gate-password');
    const gateError = document.getElementById('gate-error');
    const gateSubmitBtn = document.getElementById('gate-submit-btn');
    const toggleGatePassword = document.getElementById('toggle-gate-password');

    // Check sessionStorage — if already authenticated, skip the gate
    if (sessionStorage.getItem('authenticated') === 'true') {
        passwordGate.classList.add('hidden');
        mainApp.classList.remove('hidden');
    } else {
        passwordGate.classList.remove('hidden');
        mainApp.classList.add('hidden');
    }

    // Toggle gate password visibility
    toggleGatePassword.addEventListener('click', () => {
        const type = gatePassword.getAttribute('type') === 'password' ? 'text' : 'password';
        gatePassword.setAttribute('type', type);
        toggleGatePassword.innerHTML = type === 'password' ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
    });

    // Handle gate form submission
    gateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = gatePassword.value.trim();

        if (!password) return;

        gateSubmitBtn.disabled = true;
        gateSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
        gateError.classList.add('hidden');

        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            const result = await response.json();

            if (result.success) {
                sessionStorage.setItem('authenticated', 'true');
                passwordGate.classList.add('gate-unlocked');
                setTimeout(() => {
                    passwordGate.classList.add('hidden');
                    mainApp.classList.remove('hidden');
                }, 550);
            } else {
                gateError.classList.remove('hidden');
                gatePassword.value = '';
                gatePassword.focus();
            }
        } catch (err) {
            gateError.querySelector('span').textContent = 'Connection error. Try again.';
            gateError.classList.remove('hidden');
        } finally {
            gateSubmitBtn.disabled = false;
            gateSubmitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Enter';
        }
    });

    // ==================== MAIN APP LOGIC ====================

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
    const speedIndicator = document.getElementById('speed-indicator');
    const activityLog = document.getElementById('activity-log');
    const clearLogBtn = document.getElementById('clear-log-btn');

    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');

    // State
    let extractedEmails = [];
    let isSending = false;
    let stopRequested = false;
    let sendStartTime = 0;

    // --- Logging Helper ---
    function addLog(text, type = 'info') {
        if (!activityLog) return;
        
        // Remove empty state
        const emptyMsg = activityLog.querySelector('.log-muted');
        if (emptyMsg) emptyMsg.remove();

        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;

        let icon = '<i class="fa-solid fa-circle-info"></i>';
        if (type === 'success') icon = '<i class="fa-solid fa-check"></i>';
        if (type === 'error') icon = '<i class="fa-solid fa-xmark"></i>';
        if (type === 'warning') icon = '<i class="fa-solid fa-rotate"></i>';

        entry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span>${icon} ${text}</span>`;
        activityLog.appendChild(entry);
        activityLog.scrollTop = activityLog.scrollHeight;
    }

    if (clearLogBtn) {
        clearLogBtn.addEventListener('click', () => {
            activityLog.innerHTML = '<div class="log-entry log-muted">Log cleared. Ready for next send.</div>';
        });
    }

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

        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
        const matches = text.match(emailRegex) || [];
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
        const senderNameVal = senderName.value.trim();
        const subjectVal = subject.value.trim();
        const messageBodyVal = messageBody.value.trim();

        sendBtn.disabled = true;
        sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

        try {
            // Verify credentials first
            addLog('Verifying SMTP connection with Gmail...', 'info');

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
                addLog(`SMTP Verification Failed: ${verifyResult.message}`, 'error');
                alert(verifyResult.message || 'Invalid credentials or spam check failed.');
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
                try { turnstile.reset(); } catch(e){}
                return;
            }

            addLog('SMTP Connection verified successfully. Starting delivery queue...', 'success');

            // Start sending UI
            startSendingUI(extractedEmails.length);
            sendStartTime = Date.now();

            let totalSent = 0;
            let totalFailed = 0;
            let pendingRecipients = [...extractedEmails];
            const batchSize = 10; // 10 per batch for reliable Gmail inbox throughput

            // Main sending round
            let failedForRetry = [];

            for (let i = 0; i < pendingRecipients.length; i += batchSize) {
                if (stopRequested) break;

                const batch = pendingRecipients.slice(i, i + batchSize);
                const batchNum = Math.floor(i / batchSize) + 1;
                const totalBatches = Math.ceil(pendingRecipients.length / batchSize);

                updateProgressUI(totalSent, totalFailed, extractedEmails.length, `Sending batch ${batchNum}/${totalBatches}...`);

                try {
                    const payload = {
                        email: emailVal,
                        appPassword: appPasswordVal,
                        senderName: senderNameVal,
                        subject: subjectVal,
                        messageBody: messageBodyVal,
                        recipients: batch,
                        cfToken: turnstileResponse
                    };

                    const response = await fetch('/api/send-batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    const result = await response.json();

                    if (result.success && result.results) {
                        const batchSent = result.results.sent || 0;
                        const batchFailed = result.results.failed || 0;
                        const details = result.results.details || [];

                        totalSent += batchSent;
                        totalFailed += batchFailed;

                        // Log individual details
                        details.forEach(d => {
                            if (d.success) {
                                addLog(`Delivered to ${d.recipient}`, 'success');
                            } else {
                                addLog(`Failed to ${d.recipient}: ${d.error || 'Server error'}`, 'error');
                                failedForRetry.push(d.recipient);
                            }
                        });

                        // Fallback if details not present but failedCount > 0
                        if (details.length === 0 && result.results.failedRecipients) {
                            failedForRetry.push(...result.results.failedRecipients);
                        }
                    } else {
                        // Entire batch failed
                        totalFailed += batch.length;
                        failedForRetry.push(...batch);
                        addLog(`Batch ${batchNum} error: ${result.message || 'Unknown error'}`, 'error');
                    }
                } catch (err) {
                    console.error('Batch error:', err);
                    totalFailed += batch.length;
                    failedForRetry.push(...batch);
                    addLog(`Batch ${batchNum} network error: ${err.message}`, 'error');
                }

                updateProgressUI(totalSent, totalFailed, extractedEmails.length);
                updateSpeedIndicator(totalSent, totalFailed, extractedEmails.length);

                // Small safe jitter (100ms) to ensure Gmail reputation and 0 drops
                if (i + batchSize < pendingRecipients.length && !stopRequested) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }

            // ==================== AUTO-RETRY LOOP ====================
            const MAX_RETRIES = 3;
            let retryAttempt = 0;

            while (failedForRetry.length > 0 && retryAttempt < MAX_RETRIES && !stopRequested) {
                retryAttempt++;
                const toRetry = [...new Set(failedForRetry)];
                failedForRetry = []; // Reset for this attempt

                addLog(`Auto-Retry active: Retrying ${toRetry.length} failed email(s) (Attempt ${retryAttempt}/${MAX_RETRIES})...`, 'warning');
                statusText.textContent = `Auto-retrying ${toRetry.length} failed emails (Attempt ${retryAttempt}/${MAX_RETRIES})...`;
                statusIcon.className = 'fa-solid fa-rotate fa-spin text-warning';

                // Exponential backoff before retry (1.5s, 3s, 5s)
                const backoffDelay = retryAttempt * 1500;
                await new Promise(r => setTimeout(r, backoffDelay));

                for (let i = 0; i < toRetry.length; i += batchSize) {
                    if (stopRequested) break;

                    const batch = toRetry.slice(i, i + batchSize);

                    try {
                        const payload = {
                            email: emailVal,
                            appPassword: appPasswordVal,
                            senderName: senderNameVal,
                            subject: subjectVal,
                            messageBody: messageBodyVal,
                            recipients: batch,
                            cfToken: turnstileResponse
                        };

                        const response = await fetch('/api/send-batch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });

                        const result = await response.json();

                        if (result.success && result.results) {
                            const recovered = result.results.sent || 0;
                            const stillFailed = result.results.failed || 0;
                            const details = result.results.details || [];

                            if (recovered > 0) {
                                totalSent += recovered;
                                totalFailed -= recovered; // Recover failed count!
                            }

                            details.forEach(d => {
                                if (d.success) {
                                    addLog(`✔ Retry Success! Delivered to ${d.recipient}`, 'success');
                                } else {
                                    addLog(`❌ Retry Failed for ${d.recipient}: ${d.error || 'Server error'}`, 'error');
                                    failedForRetry.push(d.recipient);
                                }
                            });
                        } else {
                            failedForRetry.push(...batch);
                        }
                    } catch (err) {
                        failedForRetry.push(...batch);
                        addLog(`Retry request error: ${err.message}`, 'error');
                    }

                    updateProgressUI(totalSent, totalFailed, extractedEmails.length);
                    updateSpeedIndicator(totalSent, totalFailed, extractedEmails.length);
                }
            }

            // Final completion status
            isSending = false;
            if (stopRequested) {
                statusIcon.className = 'fa-solid fa-circle-stop text-danger';
                statusText.textContent = 'Stopped by user.';
                addLog('Sending process stopped by user.', 'warning');
            } else {
                statusIcon.className = 'fa-solid fa-circle-check text-success';
                const elapsed = ((Date.now() - sendStartTime) / 1000).toFixed(1);
                const retrySummary = retryAttempt > 0 ? ` (with ${retryAttempt} auto-retries)` : '';
                statusText.textContent = `Completed! ${totalSent} sent in ${elapsed}s${retrySummary}`;
                addLog(`Finished! Total: ${extractedEmails.length} | Sent: ${totalSent} | Failed: ${totalFailed} in ${elapsed}s`, totalFailed === 0 ? 'success' : 'warning');
            }

            finishSendingUI();

        } catch (error) {
            console.error('Send error:', error);
            addLog(`Fatal Error: ${error.message}`, 'error');
            alert('Failed to connect to server.');
            isSending = false;
            finishSendingUI();
        } finally {
            if (!isSending) {
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
            }
            try { turnstile.reset(); } catch(e){}
        }
    });

    // Handle Stop
    stopBtn.addEventListener('click', () => {
        stopRequested = true;
        statusIcon.className = 'fa-solid fa-spinner fa-spin text-warning';
        statusText.textContent = 'Stopping... waiting for current batch...';
        stopBtn.disabled = true;
        addLog('Stop requested. Halting subsequent batches...', 'warning');
    });

    // Helper UI functions
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

        if (speedIndicator) speedIndicator.textContent = 'Calculating speed...';
        setInputState(true);
    }

    function updateProgressUI(sentCount, failedCount, total, customText) {
        statSent.textContent = sentCount;
        statFailed.textContent = failedCount;

        const remaining = Math.max(0, total - (sentCount + failedCount));
        statRemaining.textContent = remaining;

        const percentage = Math.min(100, Math.round(((sentCount + failedCount) / total) * 100));
        progressBar.style.width = `${percentage}%`;

        if (customText && isSending && !stopRequested) {
            statusText.textContent = customText;
        }
    }

    function updateSpeedIndicator(sentCount, failedCount, total) {
        if (!speedIndicator) return;
        const elapsed = (Date.now() - sendStartTime) / 1000;
        if (elapsed < 0.5) return;

        const processed = sentCount + failedCount;
        const rate = (processed / elapsed).toFixed(1);
        const remaining = Math.max(0, total - processed);
        const etaSeconds = (rate > 0 && remaining > 0) ? Math.round(remaining / (processed / elapsed)) : 0;

        let etaStr = `${etaSeconds}s`;
        if (etaSeconds > 60) {
            etaStr = `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s`;
        }

        speedIndicator.innerHTML = `<i class="fa-solid fa-gauge-high"></i> ${rate} emails/sec &nbsp;·&nbsp; <i class="fa-solid fa-clock"></i> ETA: ${etaStr}`;
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
