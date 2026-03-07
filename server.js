const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Store active sending sessions to allow stopping
const activeSessions = {};

// Verify SMTP credentials
app.post('/api/verify', async (req, res) => {
    const { email, appPassword } = req.body;

    if (!email || !appPassword) {
        return res.status(400).json({ success: false, message: 'Email and App Password required' });
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: email,
            pass: appPassword
        }
    });

    try {
        await transporter.verify();
        res.json({ success: true, message: 'SMTP credentials verified successfully' });
    } catch (error) {
        console.error('SMTP Verification Error:', error);
        res.status(401).json({ success: false, message: 'Invalid credentials. Please check your App Password.' });
    }
});

// Start sending emails
app.post('/api/send', async (req, res) => {
    const { socketId, email, appPassword, senderName, subject, messageBody, recipients } = req.body;

    if (!socketId || !email || !appPassword || !recipients || recipients.length === 0) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Initialize session state
    activeSessions[socketId] = { stopRequested: false };

    res.json({ success: true, message: 'Sending process started' });

    // Send asynchronously
    sendEmails(socketId, email, appPassword, senderName, subject, messageBody, recipients);
});

// Stop sending emails
app.post('/api/stop', (req, res) => {
    const { socketId } = req.body;
    
    if (activeSessions[socketId]) {
        activeSessions[socketId].stopRequested = true;
        res.json({ success: true, message: 'Stop requested' });
    } else {
        res.status(404).json({ success: false, message: 'No active session found' });
    }
});

async function sendEmails(socketId, email, appPassword, senderName, subject, messageBody, recipients) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: email,
            pass: appPassword
        }
    });

    let sentCount = 0;
    let failedCount = 0;
    const total = recipients.length;

    for (let i = 0; i < total; i++) {
        // Check if stop was requested
        if (activeSessions[socketId] && activeSessions[socketId].stopRequested) {
            io.to(socketId).emit('stopped', { sentCount, failedCount, total });
            break;
        }

        const recipient = recipients[i];
        
        try {
            await transporter.sendMail({
                from: `"${senderName}" <${email}>`,
                to: recipient,
                subject: subject,
                text: messageBody, // Assuming plain text for now; we could use html: messageBody
                // html: messageBody.replace(/\n/g, '<br>') // if we want basic html support
            });
            sentCount++;
            io.to(socketId).emit('progress', { sentCount, failedCount, total, currentEmail: recipient });
        } catch (error) {
            console.error(`Failed to send to ${recipient}:`, error);
            failedCount++;
            io.to(socketId).emit('progress', { sentCount, failedCount, total, currentEmail: recipient });
        }

        // Add a small delay to avoid hitting rate limits instantly
        // Gmail has a limit of ~500/day, but sending too fast can cause temporary blocks
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Cleanup session and emit completion if not stopped
    if (activeSessions[socketId] && !activeSessions[socketId].stopRequested) {
        io.to(socketId).emit('complete', { sentCount, failedCount, total });
    }
    
    delete activeSessions[socketId];
}

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('connected', { socketId: socket.id });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        if (activeSessions[socket.id]) {
            activeSessions[socket.id].stopRequested = true;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
