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

const activeSessions = {};


// ✅ Gmail Transporter (PORT 587 FIX)
function createTransporter(email, appPassword) {

    return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,          // changed
        secure: false,      // changed
        requireTLS: true,   // added

        auth: {
            user: email,
            pass: appPassword
        },

        tls: {
            rejectUnauthorized: false
        }
    });

}


// Verify SMTP credentials
app.post('/api/verify', async (req, res) => {

    const { email, appPassword } = req.body;

    if (!email || !appPassword) {
        return res.status(400).json({
            success: false,
            message: 'Email and App Password required'
        });
    }

    try {

        const transporter = createTransporter(email, appPassword);
        await transporter.verify();

        res.json({
            success: true,
            message: 'SMTP credentials verified successfully'
        });

    } catch (error) {

        console.error("SMTP Verification Error:", error);

        res.status(401).json({
            success: false,
            message: error.message
        });

    }

});


// Start sending emails
app.post('/api/send', async (req, res) => {

    const {
        socketId,
        email,
        appPassword,
        senderName,
        subject,
        messageBody,
        recipients
    } = req.body;

    if (!socketId || !email || !appPassword || !recipients || recipients.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    activeSessions[socketId] = { stopRequested: false };

    res.json({
        success: true,
        message: 'Sending process started'
    });

    sendEmails(socketId, email, appPassword, senderName, subject, messageBody, recipients);

});


// Stop sending emails
app.post('/api/stop', (req, res) => {

    const { socketId } = req.body;

    if (activeSessions[socketId]) {

        activeSessions[socketId].stopRequested = true;

        res.json({
            success: true,
            message: 'Stop requested'
        });

    } else {

        res.status(404).json({
            success: false,
            message: 'No active session found'
        });

    }

});



async function sendEmails(socketId, email, appPassword, senderName, subject, messageBody, recipients) {

    const transporter = createTransporter(email, appPassword);

    let sentCount = 0;
    let failedCount = 0;
    const total = recipients.length;

    for (let i = 0; i < total; i++) {

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
                text: messageBody
            });

            sentCount++;

        } catch (error) {

            console.error(`Failed to send to ${recipient}`, error);
            failedCount++;

        }

        io.to(socketId).emit('progress', {
            sentCount,
            failedCount,
            total,
            currentEmail: recipient
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

    }

    if (activeSessions[socketId] && !activeSessions[socketId].stopRequested) {

        io.to(socketId).emit('complete', {
            sentCount,
            failedCount,
            total
        });

    }

    delete activeSessions[socketId];

}



io.on('connection', (socket) => {

    console.log('Client connected:', socket.id);

    socket.emit('connected', {
        socketId: socket.id
    });

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