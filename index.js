const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public")); // Melayani file di folder public

// Store session (Note: Di Vercel ini akan reset setiap deploy kecuali pakai Database)
let sock;
const sessionDir = "auth_info_baileys";

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
        printQRInTerminal: true, // Tampilkan di log juga
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Zymzz Web", "Chrome", "1.0.0"], // Nama Client
    });

    // Handle Koneksi
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Jika ada QR, convert ke Image URL dan kirim ke Web via Socket
            QRCode.toDataURL(qr, (err, url) => {
                io.emit("qr", url);
                io.emit("log", "Scan QR Code untuk Login...");
            });
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            io.emit("log", "Koneksi terputus. Menghubungkan ulang...");
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                io.emit("log", "Sesi habis. Silakan hapus folder session dan scan ulang.");
            }
        } else if (connection === "open") {
            io.emit("qr", null); // Hapus QR dari web
            io.emit("ready", true);
            io.emit("log", "Berhasil Terhubung! Siap mengirim pesan.");
            const user = sock.user;
            io.emit("user_info", { name: user.name, id: user.id });
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

connectToWhatsApp();

// --- API ROUTES UNTUK KIRIM PESAN ---

// 1. Kirim Plain Text
app.post("/send-message", async (req, res) => {
    const { number, message } = req.body;
    if (!sock) return res.status(500).json({ status: false, msg: "WA belum terhubung" });

    const id = number + "@s.whatsapp.net";
    await sock.sendMessage(id, { text: message });
    res.json({ status: true, msg: "Pesan terkirim" });
});

// 2. Kirim Button (Interactive Message)
// Note: Button seringkali tidak muncul di WA terbaru, diganti List/Reply
app.post("/send-button", async (req, res) => {
    const { number, text, footer, buttons } = req.body; // buttons = [{buttonId: 'id1', buttonText: {displayText: 'Tes'}}]
    const id = number + "@s.whatsapp.net";
    
    // Format Button Baileys terbaru (Interactive)
    const msg = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2,
                },
                interactiveMessage: {
                    body: { text: text },
                    footer: { text: footer },
                    header: { title: "", subtitle: "", hasMediaAttachment: false },
                    nativeFlowMessage: {
                        buttons: buttons.map(b => ({
                            name: "quick_reply",
                            buttonParamsJson: JSON.stringify({
                                display_text: b.displayText,
                                id: b.id
                            })
                        }))
                    }
                }
            }
        }
    };

    await sock.relayMessage(id, msg.viewOnceMessage.message, {});
    res.json({ status: true, msg: "Button dikirim" });
});

// Jalankan Server
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});

module.exports = app;