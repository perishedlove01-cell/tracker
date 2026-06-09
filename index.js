/**
 * Lifeboat SM Dashboard 
 * 
 * Setup:
 * 1. npm install bedrock-protocol discord.js
 * 2. Fill in DISCORD_TOKEN
 * 3. node dashboard.js
 * 4. /setup - Creates channels
 * 5. /start - Begin scanning (you'll auth Xbox accounts on first run)
 * 6. After first auth, backup ./auth/ folder - those are your tokens!
 */
 
const bedrock = require('bedrock-protocol');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
 
// ============================================
// GLOBAL ERROR HANDLERS - Prevent crashes
// ============================================
 
// Network status tracking
let networkDown = false;
let networkDownSince = null;
let lastNetworkError = 0;
const NETWORK_ERROR_THRESHOLD = 3; // errors within 5 sec = network down
let recentNetworkErrors = 0;
 
function isNetworkError(err) {
    const msg = err?.message || err?.toString() || '';
    const cause = err?.cause?.message || err?.cause?.code || '';
    return msg.includes('ENOTFOUND') || 
           msg.includes('ETIMEDOUT') || 
           msg.includes('ECONNREFUSED') ||
           msg.includes('EAI_AGAIN') ||
           msg.includes('fetch failed') ||
           cause.includes('ENOTFOUND') ||
           cause.includes('ETIMEDOUT');
}
 
function handleNetworkError(err, src = 'NETWORK') {
    const now = Date.now();
    
    // Count errors within 5 seconds
    if (now - lastNetworkError < 5000) {
        recentNetworkErrors++;
    } else {
        recentNetworkErrors = 1;
    }
    lastNetworkError = now;
    
    // If multiple network errors in quick succession, mark network as down
    if (recentNetworkErrors >= NETWORK_ERROR_THRESHOLD && !networkDown) {
        networkDown = true;
        networkDownSince = now;
        console.log(`[${new Date().toLocaleTimeString()}] [NETWORK] ⚠️ Network appears DOWN - pausing reconnects`);
    }
    
    // Only log if it's a new error (suppress spam)
    if (!networkDown || now - networkDownSince < 1000) {
        console.log(`[${new Date().toLocaleTimeString()}] [${src}] Network error: ${err?.cause?.code || err?.message || 'Unknown'}`);
    }
}
 
// Check if network is back (called before reconnect attempts)
async function checkNetworkStatus() {
    if (!networkDown) return true;
    
    try {
        // Try a simple DNS lookup
        const dns = require('dns').promises;
        await dns.lookup('discord.com');
        
        // Network is back!
        const downtime = Math.round((Date.now() - networkDownSince) / 1000);
        console.log(`[${new Date().toLocaleTimeString()}] [NETWORK] ✅ Network restored after ${downtime}s`);
        networkDown = false;
        networkDownSince = null;
        recentNetworkErrors = 0;
        return true;
    } catch {
        return false;
    }
}
 
process.on('uncaughtException', (err) => {
    if (isNetworkError(err)) {
        handleNetworkError(err, 'UNCAUGHT');
        return; // Don't spam full stack for network errors
    }
    console.error(`[${new Date().toLocaleTimeString()}] [CRASH PREVENTED] Uncaught Exception: ${err.message}`);
    console.error(err.stack);
});
 
process.on('unhandledRejection', (reason, promise) => {
    if (isNetworkError(reason)) {
        handleNetworkError(reason, 'REJECTION');
        return; // Don't spam full stack for network errors
    }
    console.error(`[${new Date().toLocaleTimeString()}] [CRASH PREVENTED] Unhandled Rejection: ${reason}`);
    if (reason?.stack) console.error(reason.stack);
});
 
// ============================================
// CONFIG - FILL THESE IN
// ============================================
 
// Discord bot token (from Discord Developer Portal)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
 
// Role required to use admin commands (anyone can use /flag)
const REQUIRED_ROLE = 'admin';
 
// Xbox account auth folders (auto-created on first run)
// After first auth, these folders contain your login tokens
// Back them up! They persist forever if bot keeps running
const XBOX_AUTH = {
    BOT1: './auth/bot1',
    BOT2: './auth/bot2',
    BOT3: './auth/bot3',
    BOT4: './auth/bot4',
    BOT5: './auth/bot5'
};
 
// ===========================================
// BOT SETTINGS (usually don't need to change)
// ============================================
 
const CONFIG = {
    HOST: 'mco.lbsg.net',
    PORT: 19132,
    VERSION: '1.21.100', // Force older version that works
    
    MAX_SM: 90,
    MAX_PS: 24,
    MAX_FAILURES: 8,
    
    // Reserve bot settings
    TPA_TIMEOUT: 30000,        // 30 seconds to accept TPA
    RESERVE_IDLE_WAIT: 5000,   // Time between checking queue
    
    // Timing
    TRANSFER_WAIT: 3000,
    SCAN_BUFFER: 500,
    CYCLE_DELAY: 300,
    RECONNECT_DELAY: 10000,
    CONNECT_STAGGER: 3000, // delay between bot connections
    METRICS_UPDATE: 1800000, // 30 mins
    BOT_RESYNC: 5400000, // 90 mins
    
    // Files
    MESSAGE_IDS_FILE: './message_ids.json',
    WATCHLIST_FILE: './watchlist.json',
    FLAGS_FILE: './flags.json',
    PLAYERS_FILE: './players.json',
    METRICS_FILE: './metrics.json',
    SHARED_ACCOUNTS_FILE: './sharedaccounts.json'
};
 
// Auto-detect total bots from auth folders
function detectBotCount() {
    let count = 0;
    for (let i = 1; i <= 10; i++) { // Check up to 10 bots
        if (fs.existsSync(`./auth/bot${i}`)) {
            count = i; // Keep going to find highest numbered folder
        } else {
            break; // Stop at first missing folder
        }
    }
    return Math.max(count, 2); // Minimum 2 (1 cycling + 1 reserve)
}
 
CONFIG.TOTAL_BOTS = detectBotCount();
CONFIG.CYCLING_BOTS = CONFIG.TOTAL_BOTS - 1; // Last bot is reserve
CONFIG.RESERVE_BOT = CONFIG.TOTAL_BOTS;
 
// Generate bot starting positions (spread evenly across 90 servers)
CONFIG.BOT_STARTS = {};
const spacing = Math.floor(CONFIG.MAX_SM / CONFIG.CYCLING_BOTS);
for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
    CONFIG.BOT_STARTS[i] = ((i - 1) * spacing) + 1;
}
 
console.log(`[CONFIG] Detected ${CONFIG.TOTAL_BOTS} bot auth folders`);
console.log(`[CONFIG] ${CONFIG.CYCLING_BOTS} cycling bot(s), Bot ${CONFIG.RESERVE_BOT} is reserve`);
console.log(`[CONFIG] Bot starts: ${Object.entries(CONFIG.BOT_STARTS).map(([b, s]) => `Bot${b}→SM${s}`).join(', ')}`);
 
// ============================================
// UTILS
// ============================================
const log = (src, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${src}] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeAgo = (timestamp) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};
 
// ============================================
// MINECRAFT BOT
// ============================================
class MinecraftBot {
    constructor(id, onScan, onDeviceInfo, onMsaCode) {
        this.id = id;
        this.onScan = onScan;
        this.onDeviceInfo = onDeviceInfo;
        this.onMsaCode = onMsaCode;
        
        this.client = null;
        this.isConnected = false;
        this.currentServer = null;
        this.pendingTransfer = null;
        this.isRunning = false;
        this.shouldStop = false;
        
        this.playersOnServer = new Map();
        this.transferSucceeded = false;
        this.lastTransferFailed = false;
        
        this.currentSm = CONFIG.BOT_STARTS[id];
        this.consecutiveFailures = 0;
        this.gamertag = null;
    }
    
    async connect() {
        if (this.isConnected) return true;
        
        const authFolder = XBOX_AUTH[`BOT${this.id}`];
        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }
        
        log(`Bot${this.id}`, 'Connecting...');
        
        return new Promise(resolve => {
            let resolved = false;
            const safeResolve = (value) => {
                if (!resolved) {
                    resolved = true;
                    resolve(value);
                }
            };
            
            try {
                this.client = bedrock.createClient({
                    host: CONFIG.HOST,
                    port: CONFIG.PORT,
                    version: CONFIG.VERSION,
                    offline: false,
                    profilesFolder: authFolder,
                    onMsaCode: (data) => {
                        log(`Bot${this.id}`, `AUTH: ${data.verification_uri} | Code: ${data.user_code}`);
                        if (this.onMsaCode) this.onMsaCode(this.id, data.verification_uri, data.user_code);
                    }
                });
            } catch (e) {
                log(`Bot${this.id}`, `Connect failed: ${e.message}`);
                return safeResolve(false);
            }
            
            const timeout = setTimeout(() => {
                log(`Bot${this.id}`, 'Connection timeout');
                safeResolve(false);
            }, 60000);
            
            this.client.on('join', () => {
                clearTimeout(timeout);
                this.isConnected = true;
                this.currentServer = null;
                this.gamertag = this.client.profile?.name || 'Unknown';
                log(`Bot${this.id}`, `Connected as ${this.gamertag}`);
                safeResolve(true);
            });
            
            this.client.on('player_list', (packet) => {
                if (packet.records?.type === 'add') {
                    const players = packet.records.records || [];
                    players.forEach(record => {
                        const name = record.username || record.name;
                        if (name && name !== this.gamertag && !this.playersOnServer.has(name)) {
                            this.playersOnServer.set(name, { name, uuid: record.uuid });
                        }
                    });
                } else if (packet.records?.type === 'remove') {
                    const players = packet.records.records || [];
                    players.forEach(record => {
                        for (const [name, data] of this.playersOnServer.entries()) {
                            if (data.uuid === record.uuid) {
                                this.playersOnServer.delete(name);
                                break;
                            }
                        }
                    });
                }
            });
            
            // Listen for add_player to capture device info
            this.client.on('add_player', (packet) => {
                const name = packet.username;
                const deviceId = packet.device_id || packet.DeviceId || null;
                const buildPlatform = packet.build_platform || packet.BuildPlatform || null;
                
                if (name && name !== this.gamertag && this.onDeviceInfo) {
                    this.onDeviceInfo(name, deviceId, buildPlatform);
                }
            });
            
            this.client.on('text', (packet) => {
                const msg = packet.message || '';
                const lower = msg.toLowerCase();
                
                if (lower.includes('out of rotation') || lower.includes('not available') || lower.includes('server not found')) {
                    this.lastTransferFailed = true;
                }
                
                if ((msg.includes('Survival Mode') || lower.includes('survival mode')) && this.pendingTransfer) {
                    this.transferSucceeded = true;
                    this.currentServer = this.pendingTransfer;
                    this.pendingTransferType = null;
                    this.pendingTransfer = null;
                    this.consecutiveFailures = 0;
                }
                
                // PS (Pixelmon Survival) success detection
                if ((msg.includes('Pixelmon') || lower.includes('pixelmon') || lower.includes('pixelsurvival') || lower.includes('pixel survival')) && this.pendingTransfer && this.pendingTransferType === 'ps') {
                    this.transferSucceeded = true;
                    this.currentServer = this.pendingTransfer;
                    this.currentServerType = 'ps';
                    this.pendingTransferType = null;
                    this.pendingTransfer = null;
                    this.consecutiveFailures = 0;
                }
            });
            
            this.client.on('disconnect', () => {
                log(`Bot${this.id}`, 'Disconnected');
                this.handleDisconnect();
                clearTimeout(timeout);
                safeResolve(false);
            });
            
            this.client.on('close', () => {
                this.handleDisconnect();
                clearTimeout(timeout);
                safeResolve(false);
            });
            
            this.client.on('error', (e) => {
                // Auth/network errors - resolve as failed
                if (e.message?.includes('Connect Timeout') || 
                    e.message?.includes('fetch failed') ||
                    e.message?.includes('ECONNREFUSED') ||
                    e.message?.includes('ETIMEDOUT') ||
                    e.code === 'UND_ERR_CONNECT_TIMEOUT') {
                    log(`Bot${this.id}`, `Network error: ${e.message || e.code}`);
                    clearTimeout(timeout);
                    safeResolve(false);
                    return;
                }
                
                if (!e.message?.includes('Missing')) {
                    log(`Bot${this.id}`, `Error: ${e.message}`);
                }
            });
        });
    }
    
    handleDisconnect() {
        this.isConnected = false;
        this.currentServer = null;
        this.currentServerType = null;
        this.pendingTransfer = null;
        this.pendingTransferType = null;
        this.playersOnServer.clear();
        this.client = null;
    }
    
    async transferTo(num, type = 'sm') {
        this.pendingTransfer = num;
        this.pendingTransferType = type;
        this.lastTransferFailed = false;
        this.transferSucceeded = false;
        this.playersOnServer.clear();
        
        const inLobby = (this.currentServer === null);
        const cmd = `/transfer ${type}${num}`;
        
        if (inLobby) {
            this.client.queue('text', {
                type: 'chat',
                needs_translation: false,
                source_name: this.client.profile?.name || 'Player',
                xuid: this.client.profile?.xuid || '',
                platform_chat_id: '',
                message: cmd,
                filtered_message: ''
            });
        } else {
            this.client.queue('command_request', {
                command: cmd,
                origin: {
                    type: 'player',
                    uuid: this.client.profile?.uuid || '',
                    request_id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
                }
            });
        }
        
        await sleep(CONFIG.TRANSFER_WAIT);
        
        if (this.transferSucceeded || this.playersOnServer.size > 0) {
            this.currentServer = num;
            this.currentServerType = type;
            this.consecutiveFailures = 0;
            return true;
        }
        
        this.consecutiveFailures++;
        return false;
    }
    
    async goToLobby() {
        if (this.currentServer === null) return;
        
        this.client.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.client.profile?.name || 'Player',
            xuid: this.client.profile?.xuid || '',
            platform_chat_id: '',
            message: '/hub',
            filtered_message: ''
        });
        
        await sleep(CONFIG.TRANSFER_WAIT + 2000);
        this.currentServer = null;
        this.playersOnServer.clear();
    }
    
    async scanServer(num, type = 'sm') {
        if (!this.isConnected || !this.client) {
            return false;
        }
        
        const success = await this.transferTo(num, type);
        
        if (!success) {
            if (this.isConnected && this.onScan) {
                this.onScan(num, null, this.id, type);
            }
            return false;
        }
        
        await sleep(CONFIG.SCAN_BUFFER);
        
        const players = Array.from(this.playersOnServer.values()).map(p => p.name);
        log(`Bot${this.id}`, `${type}${num}: ${players.length} players`);
        
        if (this.onScan) this.onScan(num, players, this.id, type);
        
        return true;
    }
    
    async startCycling() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.shouldStop = false;
        this.currentSm = CONFIG.BOT_STARTS[this.id];
        this.scanningPs = false;
        this.currentPs = 1;
        
        log(`Bot${this.id}`, `Starting from sm${this.currentSm}`);
        
        while (this.isRunning && !this.shouldStop) {
            if (!this.isConnected) {
                let attempt = 0;
                const maxAttempts = 3;
                let connected = false;
                
                while (!connected && attempt < maxAttempts && !this.shouldStop) {
                    attempt++;
                    connected = await this.connect();
                    
                    if (!connected) {
                        const waitTime = CONFIG.RECONNECT_DELAY * attempt;
                        log(`Bot${this.id}`, `Connection attempt ${attempt}/${maxAttempts} failed, waiting ${waitTime/1000}s...`);
                        await sleep(waitTime);
                    }
                }
                
                if (!connected) {
                    log(`Bot${this.id}`, 'Failed to connect after all attempts, cooling down 1 minute...');
                    await sleep(60000);
                    continue;
                }
                await sleep(2000);
            }
            
            if (this.scanningPs) {
                // PS scan phase
                await this.scanServer(this.currentPs, 'ps');
                
                if (this.consecutiveFailures >= CONFIG.MAX_FAILURES) {
                    log(`Bot${this.id}`, 'Too many PS failures, switching back to SM scan');
                    this.scanningPs = false;
                    this.currentPs = 1;
                    this.consecutiveFailures = 0;
                    await this.goToLobby();
                    await sleep(3000);
                    continue;
                }
                
                this.currentPs++;
                if (this.currentPs > CONFIG.MAX_PS) {
                    // Done with PS cycle — go back to SM scanning
                    log(`Bot${this.id}`, 'PS scan complete, resuming SM scan');
                    this.scanningPs = false;
                    this.currentPs = 1;
                    await this.goToLobby();
                    await sleep(3000);
                }
            } else {
                // SM scan phase
                await this.scanServer(this.currentSm, 'sm');
                
                if (this.consecutiveFailures >= CONFIG.MAX_FAILURES) {
                    log(`Bot${this.id}`, 'Too many failures, reconnecting and resetting to sm1');
                    
                    try { this.client.close(); } catch {}
                    this.handleDisconnect();
                    
                    if (networkDown) {
                        log(`Bot${this.id}`, 'Network is down, waiting for recovery...');
                        while (networkDown && !this.shouldStop) {
                            await sleep(10000);
                            await checkNetworkStatus();
                        }
                        if (this.shouldStop) break;
                        log(`Bot${this.id}`, 'Network recovered, resuming...');
                    }
                    
                    let reconnectAttempt = 0;
                    const maxReconnectAttempts = 5;
                    let connected = false;
                    
                    while (!connected && reconnectAttempt < maxReconnectAttempts && !this.shouldStop) {
                        if (networkDown) {
                            log(`Bot${this.id}`, 'Network down during reconnect, waiting...');
                            while (networkDown && !this.shouldStop) {
                                await sleep(10000);
                                await checkNetworkStatus();
                            }
                            if (this.shouldStop) break;
                        }
                        
                        reconnectAttempt++;
                        const waitTime = Math.min(5000 * Math.pow(2, reconnectAttempt - 1), 60000);
                        
                        log(`Bot${this.id}`, `Reconnect attempt ${reconnectAttempt}/${maxReconnectAttempts} in ${waitTime/1000}s...`);
                        await sleep(waitTime);
                        
                        connected = await this.connect();
                        
                        if (!connected) {
                            log(`Bot${this.id}`, `Reconnect attempt ${reconnectAttempt} failed`);
                        }
                    }
                    
                    if (!connected) {
                        log(`Bot${this.id}`, 'All reconnect attempts failed, waiting 2 minutes...');
                        await sleep(120000);
                        continue;
                    }
                    
                    this.currentSm = 1;
                    this.consecutiveFailures = 0;
                    await sleep(3000);
                    continue;
                }
                
                this.currentSm++;
                if (this.currentSm > CONFIG.MAX_SM) {
                    // Finished full SM cycle — now scan PS servers
                    this.currentSm = 1;
                    log(`Bot${this.id}`, 'SM cycle complete, starting PS1-24 scan');
                    this.scanningPs = true;
                    this.currentPs = 1;
                    await this.goToLobby();
                    await sleep(3000);
                }
            }
            
            await sleep(CONFIG.CYCLE_DELAY);
        }
        
        this.isRunning = false;
    }
    
    stop() {
        this.shouldStop = true;
        this.isRunning = false;
    }
    
    async disconnect() {
        this.stop();
        if (this.client) {
            try { this.client.close(); } catch {}
        }
        this.handleDisconnect();
    }
}
 
// ============================================
// RESERVE BOT - For TPA coord requests
// ============================================
class ReserveBot {
    constructor(id, onCoordResult) {
        this.id = id;
        this.onCoordResult = onCoordResult; // callback(requestId, success, coords)
        
        this.client = null;
        this.isConnected = false;
        this.gamertag = null;
        this.currentServer = null;
        this.pendingTransfer = null;
        this.runtimeEntityId = null;
        
        // TPA state
        this.isProcessing = false;
        this.currentRequest = null;
        this.tpaAccepted = false;
        this.tpaDenied = false;
        this.currentPosition = null;
        
        // Queue of TPA requests
        this.queue = []; // { id, playerName, sm, userId, channelId, messageId, timestamp }
    }
    
    async connect() {
        if (this.isConnected) return true;
        
        const authFolder = XBOX_AUTH[`BOT${this.id}`];
        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }
        
        log(`Reserve`, 'Connecting...');
        
        return new Promise(resolve => {
            let resolved = false;
            const safeResolve = (value) => {
                if (!resolved) {
                    resolved = true;
                    resolve(value);
                }
            };
            
            try {
                this.client = bedrock.createClient({
                    host: CONFIG.HOST,
                    port: CONFIG.PORT,
                    version: CONFIG.VERSION,
                    offline: false,
                    profilesFolder: authFolder,
                    onMsaCode: (data) => {
                        log(`Reserve`, `AUTH: ${data.verification_uri} | Code: ${data.user_code}`);
                    }
                });
            } catch (e) {
                log(`Reserve`, `Connect failed: ${e.message}`);
                return safeResolve(false);
            }
            
            const timeout = setTimeout(() => {
                log(`Reserve`, 'Connection timeout');
                safeResolve(false);
            }, 60000);
            
            this.client.on('join', () => {
                clearTimeout(timeout);
                this.isConnected = true;
                this.currentServer = null;
                this.gamertag = this.client.profile?.name || 'Unknown';
                log(`Reserve`, `Connected as ${this.gamertag}`);
                safeResolve(true);
            });
            
            // Listen for TPA responses
            this.client.on('text', (packet) => {
                const msg = packet.message || '';
                const lower = msg.toLowerCase();
                
                // Detect TPA accept
                if (lower.includes('accepted') && lower.includes('teleport')) {
                    log(`Reserve`, 'TPA accepted!');
                    this.tpaAccepted = true;
                }
                
                // Detect TPA deny
                if (lower.includes('denied') || lower.includes('rejected') || 
                    (lower.includes('teleport') && lower.includes('failed'))) {
                    log(`Reserve`, 'TPA denied');
                    this.tpaDenied = true;
                }
                
                // Detect player not found
                if (lower.includes('player not found') || lower.includes('not online')) {
                    log(`Reserve`, 'Player not found');
                    this.tpaDenied = true;
                }
                
                // Detect transfer success
                if (msg.includes('Survival Mode') || lower.includes('survival mode')) {
                    this.currentServer = this.pendingTransfer || this.currentServer;
                    this.pendingTransfer = null;
                }
            });
            
            // Track our position from move_player
            this.client.on('move_player', (packet) => {
                if (packet.runtime_id === this.runtimeEntityId && packet.position) {
                    this.currentPosition = {
                        x: Math.round(packet.position.x),
                        y: Math.round(packet.position.y),
                        z: Math.round(packet.position.z)
                    };
                }
            });
            
            // Get runtime ID from start_game
            this.client.on('start_game', (packet) => {
                this.runtimeEntityId = packet.runtime_entity_id;
                if (packet.player_position) {
                    this.currentPosition = {
                        x: Math.round(packet.player_position.x),
                        y: Math.round(packet.player_position.y),
                        z: Math.round(packet.player_position.z)
                    };
                }
            });
            
            this.client.on('disconnect', () => {
                log(`Reserve`, 'Disconnected');
                this.handleDisconnect();
                clearTimeout(timeout);
                safeResolve(false);
            });
            
            this.client.on('close', () => {
                this.handleDisconnect();
                clearTimeout(timeout);
                safeResolve(false);
            });
            
            this.client.on('error', (e) => {
                if (e.message?.includes('Connect Timeout') || 
                    e.message?.includes('fetch failed') ||
                    e.code === 'UND_ERR_CONNECT_TIMEOUT') {
                    log(`Reserve`, `Network error: ${e.message || e.code}`);
                    clearTimeout(timeout);
                    safeResolve(false);
                    return;
                }
                if (!e.message?.includes('Missing')) {
                    log(`Reserve`, `Error: ${e.message}`);
                }
            });
        });
    }
    
    handleDisconnect() {
        this.isConnected = false;
        this.currentServer = null;
        this.client = null;
        this.isProcessing = false;
    }
    
    // Add a TPA request to the queue
    queueRequest(playerName, sm, userId, channelId, messageId) {
        const request = {
            id: Date.now(),
            playerName,
            sm,
            userId,
            channelId,
            messageId,
            timestamp: Date.now()
        };
        
        this.queue.push(request);
        log(`Reserve`, `Queued TPA request for ${playerName} on sm${sm} (queue: ${this.queue.length})`);
        
        return request.id;
    }
    
    // Get queue position for a request
    getQueuePosition(requestId) {
        const idx = this.queue.findIndex(r => r.id === requestId);
        return idx + 1; // 1-indexed position, 0 if not found
    }
    
    // Transfer to a server
    async transferTo(smNum) {
        if (!this.isConnected || !this.client) return false;
        
        this.pendingTransfer = smNum;
        
        this.client.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.gamertag || 'Player',
            xuid: this.client.profile?.xuid || '',
            platform_chat_id: '',
            message: `/server sm${smNum}`,
            filtered_message: ''
        });
        
        log(`Reserve`, `Transferring to sm${smNum}...`);
        await sleep(CONFIG.TRANSFER_WAIT + 1000);
        
        return true;
    }
    
    // Send TPA request
    async sendTPA(playerName) {
        if (!this.isConnected || !this.client) return false;
        
        this.tpaAccepted = false;
        this.tpaDenied = false;
        
        this.client.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.gamertag || 'Player',
            xuid: this.client.profile?.xuid || '',
            platform_chat_id: '',
            message: `/tpa ${playerName}`,
            filtered_message: ''
        });
        
        log(`Reserve`, `Sent /tpa ${playerName}`);
        return true;
    }
    
    // Go back to lobby
    async goToLobby() {
        if (!this.isConnected || !this.client) return;
        
        this.client.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.gamertag || 'Player',
            xuid: this.client.profile?.xuid || '',
            platform_chat_id: '',
            message: '/hub',
            filtered_message: ''
        });
        
        await sleep(CONFIG.TRANSFER_WAIT);
        this.currentServer = null;
    }
    
    // Process a single TPA request
    async processRequest(request) {
        this.isProcessing = true;
        this.currentRequest = request;
        
        log(`Reserve`, `Processing TPA for ${request.playerName} on sm${request.sm}`);
        
        try {
            // Step 1: Connect if needed
            if (!this.isConnected) {
                if (!await this.connect()) {
                    log(`Reserve`, 'Failed to connect');
                    this.onCoordResult(request.id, false, null, 'Bot failed to connect');
                    this.isProcessing = false;
                    this.currentRequest = null;
                    return;
                }
                await sleep(2000);
            }
            
            // Step 2: Transfer to the server
            if (this.currentServer !== request.sm) {
                await this.transferTo(request.sm);
            }
            
            // Step 3: Send TPA
            await this.sendTPA(request.playerName);
            
            // Step 4: Wait for response (30 sec timeout)
            const startTime = Date.now();
            while (!this.tpaAccepted && !this.tpaDenied && (Date.now() - startTime) < CONFIG.TPA_TIMEOUT) {
                await sleep(500);
            }
            
            if (this.tpaAccepted && this.currentPosition) {
                log(`Reserve`, `TPA accepted! Coords: (${this.currentPosition.x}, ${this.currentPosition.y}, ${this.currentPosition.z})`);
                this.onCoordResult(request.id, true, this.currentPosition, null);
            } else if (this.tpaDenied) {
                log(`Reserve`, 'TPA was denied');
                this.onCoordResult(request.id, false, null, 'TPA denied');
            } else {
                log(`Reserve`, 'TPA timed out');
                this.onCoordResult(request.id, false, null, 'TPA timed out (30s)');
            }
            
            // Step 5: Go back to lobby
            await this.goToLobby();
            
        } catch (e) {
            log(`Reserve`, `Error processing request: ${e.message}`);
            this.onCoordResult(request.id, false, null, e.message);
        }
        
        this.isProcessing = false;
        this.currentRequest = null;
    }
    
    // Main processing loop
    async startProcessing() {
        log(`Reserve`, 'Starting TPA queue processor');
        
        while (true) {
            // Check if there's work to do
            if (this.queue.length > 0 && !this.isProcessing) {
                const request = this.queue.shift();
                await this.processRequest(request);
            }
            
            await sleep(CONFIG.RESERVE_IDLE_WAIT);
        }
    }
    
    async disconnect() {
        if (this.client) {
            try { this.client.close(); } catch {}
        }
        this.handleDisconnect();
    }
}
 
// ============================================
// DASHBOARD
// ============================================
class Dashboard {
    constructor() {
        this.discord = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        this.bots = {};
        this.reserveBot = null;  // Reserve bot for TPA coords
        this.reserveBotId = 5;   // Default, will adjust based on connected bots
        
        this.messageIds = {}; // { "sm-1": "msgId", "ps-1": "msgId", ... }
        this.channelIds = {}; // { "1-10": "channelId", "ps1-24": "channelId" }
        this.overflowIds = {}; // { "1-10": "msgId", "ps1-24": "msgId" }
        this.overflowData = {}; // overflow data keyed same
        
        // Special channels
        this.statusChannelId = null;
        this.inputChannelId = null;
        this.resetChannelId = null;
        this.flagChannelId = null;
        this.metricsChannelId = null;
        this.metricsMessageId = null;
        this.resetMessageIds = {}; // { "1": "msgId", ... }
        
        // PS channel
        this.psChannelId = null;
        this.psMessageIds = {}; // { "1": "msgId", ... "24": "msgId" }
        this.psOverflowId = null;
        this.psOverflowData = {};
        
        // Cache watchlist and flags
        this.watchlist = []; // { original, normalized }
        this.flags = []; // { playerNormalized, playerOriginal, userId, timestamp }
        
        // TPA request tracking
        this.tpaRequests = new Map(); // requestId -> { channelId, messageId, playerName, sm, userId }
        
        // Player tracking
        this.players = {}; // { "playername": { current, history, servers, deviceId } }
        this.metrics = { servers: {} }; // { servers: { "1": { players, scans } } }
        this.sharedAccounts = {}; // { "deviceId": ["player1", "player2", ...] }
        this.deviceToPlayers = {}; // Quick lookup: deviceId -> [players]
        
        // Reset scan state
        this.resetScanActive = false;
        this.resetScanChecked = new Set();
        
        // Auth flow state
        this.authPendingBots = {};   // { botId: { url, code, status } }
        this.authConfirmPending = false; // waiting for yes/no after all auths done
        this.authStartInteraction = null;
        
        this.loadMessageIds();
        this.loadWatchlist();
        this.loadFlags();
        this.loadPlayers();
        this.loadMetrics();
        this.loadSharedAccounts();
        
        // Create cycling bots (1-4)
        for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
            this.bots[i] = new MinecraftBot(
                i, 
                (num, players, botId, type) => this.updateDisplay(num, players, botId, type),
                (name, deviceId, buildPlatform) => this.trackPlayerDevice(name, deviceId, buildPlatform),
                (botId, url, code) => this.handleMsaCode(botId, url, code)
            );
        }
        
        // Create reserve bot (last bot)
        this.reserveBot = new ReserveBot(
            CONFIG.RESERVE_BOT,
            (requestId, success, coords, error) => this.handleCoordResult(requestId, success, coords, error)
        );
    }
    
    // Handle coord result from reserve bot
    async handleCoordResult(requestId, success, coords, error) {
        const request = this.tpaRequests.get(requestId);
        if (!request) {
            log('RESERVE', `No request found for ID ${requestId}`);
            return;
        }
        
        try {
            const channel = await this.discord.channels.fetch(request.channelId);
            const message = await channel.messages.fetch(request.messageId);
            
            if (!message) {
                log('RESERVE', 'Could not find message to update');
                return;
            }
            
            const oldEmbed = message.embeds[0];
            if (!oldEmbed) return;
            
            // Build new embed with coord result
            const newEmbed = EmbedBuilder.from(oldEmbed);
            
            // Find and update the Coords field
            const fields = newEmbed.data.fields || [];
            const coordFieldIndex = fields.findIndex(f => f.name === 'Coords');
            
            if (coordFieldIndex !== -1) {
                if (success && coords) {
                    fields[coordFieldIndex].value = `**${coords.x}, ${coords.y}, ${coords.z}**`;
                    newEmbed.setColor(0x00FF00); // Green for success
                } else {
                    fields[coordFieldIndex].value = `❌ ${error || 'Failed'}`;
                    newEmbed.setColor(0xFFA500); // Orange for failed
                }
            }
            
            await message.edit({ embeds: [newEmbed] });
            log('RESERVE', `Updated message with coords: ${success ? `(${coords.x}, ${coords.y}, ${coords.z})` : error}`);
            
        } catch (e) {
            log('RESERVE', `Failed to update message: ${e.message}`);
        }
        
        this.tpaRequests.delete(requestId);
    }
    
    loadMessageIds() {
        try {
            if (fs.existsSync(CONFIG.MESSAGE_IDS_FILE)) {
                const data = JSON.parse(fs.readFileSync(CONFIG.MESSAGE_IDS_FILE, 'utf8'));
                this.messageIds = data.messages || {};
                this.channelIds = data.channels || {};
                this.overflowIds = data.overflow || {};
                this.statusChannelId = data.statusChannel || null;
                this.inputChannelId = data.inputChannel || null;
                this.resetChannelId = data.resetChannel || null;
                this.flagChannelId = data.flagChannel || null;
                this.metricsChannelId = data.metricsChannel || null;
                this.metricsMessageId = data.metricsMessage || null;
                this.resetMessageIds = data.resetMessages || {};
                // PS data (may not exist in old files)
                this.psMessageIds = data.psMessages || {};
                this.psChannelId = data.psChannel || null;
                this.psOverflowId = data.psOverflow || null;
                log('DASHBOARD', `Loaded ${Object.keys(this.messageIds).length} message IDs`);
            }
        } catch (e) {
            log('DASHBOARD', `Load error: ${e.message}`);
        }
    }
    
    saveMessageIds() {
        try {
            fs.writeFileSync(CONFIG.MESSAGE_IDS_FILE, JSON.stringify({
                messages: this.messageIds,
                channels: this.channelIds,
                overflow: this.overflowIds,
                statusChannel: this.statusChannelId,
                inputChannel: this.inputChannelId,
                resetChannel: this.resetChannelId,
                flagChannel: this.flagChannelId,
                metricsChannel: this.metricsChannelId,
                metricsMessage: this.metricsMessageId,
                resetMessages: this.resetMessageIds,
                psMessages: this.psMessageIds || {},
                psChannel: this.psChannelId || null,
                psOverflow: this.psOverflowId || null
            }, null, 2));
        } catch (e) {
            log('DASHBOARD', `Save error: ${e.message}`);
        }
    }
    
    loadWatchlist() {
        try {
            if (fs.existsSync(CONFIG.WATCHLIST_FILE)) {
                this.watchlist = JSON.parse(fs.readFileSync(CONFIG.WATCHLIST_FILE, 'utf8'));
                log('DASHBOARD', `Loaded ${this.watchlist.length} watch terms`);
            }
        } catch (e) {
            log('DASHBOARD', `Watchlist load error: ${e.message}`);
            this.watchlist = [];
        }
    }
    
    saveWatchlist() {
        try {
            fs.writeFileSync(CONFIG.WATCHLIST_FILE, JSON.stringify(this.watchlist, null, 2));
        } catch (e) {
            log('DASHBOARD', `Watchlist save error: ${e.message}`);
        }
    }
    
    loadFlags() {
        try {
            if (fs.existsSync(CONFIG.FLAGS_FILE)) {
                this.flags = JSON.parse(fs.readFileSync(CONFIG.FLAGS_FILE, 'utf8'));
                log('DASHBOARD', `Loaded ${this.flags.length} flags`);
            }
        } catch (e) {
            log('DASHBOARD', `Flags load error: ${e.message}`);
            this.flags = [];
        }
    }
    
    saveFlags() {
        try {
            fs.writeFileSync(CONFIG.FLAGS_FILE, JSON.stringify(this.flags, null, 2));
        } catch (e) {
            log('DASHBOARD', `Flags save error: ${e.message}`);
        }
    }
    
    loadPlayers() {
        try {
            if (fs.existsSync(CONFIG.PLAYERS_FILE)) {
                this.players = JSON.parse(fs.readFileSync(CONFIG.PLAYERS_FILE, 'utf8'));
                log('DASHBOARD', `Loaded ${Object.keys(this.players).length} players`);
            }
        } catch (e) {
            log('DASHBOARD', `Players load error: ${e.message}`);
            this.players = {};
        }
    }
    
    savePlayers() {
        try {
            fs.writeFileSync(CONFIG.PLAYERS_FILE, JSON.stringify(this.players, null, 2));
        } catch (e) {
            log('DASHBOARD', `Players save error: ${e.message}`);
        }
    }
    
    loadMetrics() {
        try {
            if (fs.existsSync(CONFIG.METRICS_FILE)) {
                this.metrics = JSON.parse(fs.readFileSync(CONFIG.METRICS_FILE, 'utf8'));
                log('DASHBOARD', `Loaded metrics for ${Object.keys(this.metrics.servers || {}).length} servers`);
            }
        } catch (e) {
            log('DASHBOARD', `Metrics load error: ${e.message}`);
            this.metrics = { servers: {} };
        }
    }
    
    saveMetrics() {
        try {
            fs.writeFileSync(CONFIG.METRICS_FILE, JSON.stringify(this.metrics, null, 2));
        } catch (e) {
            log('DASHBOARD', `Metrics save error: ${e.message}`);
        }
    }
    
    loadSharedAccounts() {
        try {
            if (fs.existsSync(CONFIG.SHARED_ACCOUNTS_FILE)) {
                this.sharedAccounts = JSON.parse(fs.readFileSync(CONFIG.SHARED_ACCOUNTS_FILE, 'utf8'));
                // Build quick lookup
                for (const [deviceId, players] of Object.entries(this.sharedAccounts)) {
                    this.deviceToPlayers[deviceId] = players;
                }
                log('DASHBOARD', `Loaded ${Object.keys(this.sharedAccounts).length} shared device groups`);
            }
        } catch (e) {
            log('DASHBOARD', `Shared accounts load error: ${e.message}`);
            this.sharedAccounts = {};
        }
    }
    
    saveSharedAccounts() {
        try {
            fs.writeFileSync(CONFIG.SHARED_ACCOUNTS_FILE, JSON.stringify(this.sharedAccounts, null, 2));
        } catch (e) {
            log('DASHBOARD', `Shared accounts save error: ${e.message}`);
        }
    }
    
    // Track player sighting (without device ID - for text packet sightings)
    trackPlayer(playerName, num, type = 'sm') {
        const key = playerName.toLowerCase();
        const now = Date.now();
        const serverKey = `${type}-${num}`;
        
        if (!this.players[key]) {
            this.players[key] = {
                name: playerName,
                current: null,
                history: [],
                servers: {},
                deviceId: null,
                buildPlatform: null
            };
        }
        
        const player = this.players[key];
        
        // Update current
        player.current = { sm: num, type, time: now };
        
        // Add to history (avoid duplicates in a row)
        if (!player.history.length || player.history[0].sm !== num || player.history[0].type !== type) {
            player.history.unshift({ sm: num, type, time: now });
            if (player.history.length > 10) player.history.length = 10;
        }
        
        // Count server visits
        player.servers[serverKey] = (player.servers[serverKey] || 0) + 1;
    }
    
    // Track player with device info (from add_player packet)
    trackPlayerDevice(playerName, deviceId, buildPlatform) {
        if (!deviceId || deviceId === '') return;
        
        const key = playerName.toLowerCase();
        
        // Initialize player if needed
        if (!this.players[key]) {
            this.players[key] = {
                name: playerName,
                current: null,
                history: [],
                servers: {},
                deviceId: null,
                buildPlatform: null
            };
        }
        
        const player = this.players[key];
        const oldDeviceId = player.deviceId;
        
        // Update device info
        player.deviceId = deviceId;
        player.buildPlatform = buildPlatform;
        
        // Handle shared accounts tracking
        if (deviceId) {
            // Remove from old device group if changed
            if (oldDeviceId && oldDeviceId !== deviceId && this.sharedAccounts[oldDeviceId]) {
                this.sharedAccounts[oldDeviceId] = this.sharedAccounts[oldDeviceId].filter(p => p !== key);
                if (this.sharedAccounts[oldDeviceId].length === 0) {
                    delete this.sharedAccounts[oldDeviceId];
                }
            }
            
            // Add to new device group
            if (!this.sharedAccounts[deviceId]) {
                this.sharedAccounts[deviceId] = [];
            }
            
            if (!this.sharedAccounts[deviceId].includes(key)) {
                this.sharedAccounts[deviceId].push(key);
                
                // Log if this creates a shared account situation
                if (this.sharedAccounts[deviceId].length > 1) {
                    const names = this.sharedAccounts[deviceId].map(p => this.players[p]?.name || p);
                    log('DEVICE', `Linked accounts detected: ${names.join(', ')} (${deviceId.substring(0, 8)}...)`);
                }
            }
            
            this.deviceToPlayers[deviceId] = this.sharedAccounts[deviceId];
        }
    }
    
    // Get alts for a player
    getPlayerAlts(playerName) {
        const key = playerName.toLowerCase();
        const player = this.players[key];
        
        if (!player || !player.deviceId) return [];
        
        const deviceId = player.deviceId;
        const alts = this.sharedAccounts[deviceId] || [];
        
        // Return all accounts except the queried one
        return alts.filter(p => p !== key).map(p => this.players[p]?.name || p);
    }
    
    // Get platform name
    getPlatformName(buildPlatform) {
        const platforms = {
            1: 'Android',
            2: 'iOS',
            3: 'macOS',
            4: 'FireOS',
            5: 'GearVR',
            6: 'HoloLens',
            7: 'Windows 10',
            8: 'Windows',
            9: 'Dedicated',
            10: 'tvOS',
            11: 'PlayStation',
            12: 'Nintendo Switch',
            13: 'Xbox',
            14: 'Windows Phone'
        };
        return platforms[buildPlatform] || `Unknown (${buildPlatform})`;
    }
    
    // Track server metrics
    trackServer(sm, playerCount) {
        if (!this.metrics.servers[sm]) {
            this.metrics.servers[sm] = { players: 0, scans: 0 };
        }
        this.metrics.servers[sm].players += playerCount;
        this.metrics.servers[sm].scans += 1;
    }
    
    // Get player history
    getPlayerHistory(playerName) {
        const key = playerName.toLowerCase();
        return this.players[key] || null;
    }
    
    // Get popular servers
    getPopularServers() {
        const servers = [];
        for (const [sm, data] of Object.entries(this.metrics.servers)) {
            if (data.scans > 0) {
                servers.push({
                    sm: parseInt(sm),
                    avg: (data.players / data.scans).toFixed(1),
                    total: data.players,
                    scans: data.scans
                });
            }
        }
        return servers.sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg));
    }
    
    // Update metrics embed
    async updateMetricsEmbed() {
        if (!this.metricsChannelId || !this.metricsMessageId) return;
        
        try {
            const channel = await this.discord.channels.fetch(this.metricsChannelId);
            const message = await channel.messages.fetch(this.metricsMessageId);
            
            const popular = this.getPopularServers().slice(0, 10);
            const totalPlayers = Object.keys(this.players).length;
            const totalScans = Object.values(this.metrics.servers)
                .reduce((sum, s) => sum + s.scans, 0);
            
            // Bot status
            const botStatus = [];
            for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                const b = this.bots[i];
                if (b.isRunning) {
                    botStatus.push(`Bot ${i}: SM${b.currentSm}`);
                }
            }
            // Reserve bot status
            if (this.reserveBot.isConnected || this.reserveBot.queue.length > 0) {
                const rb = this.reserveBot;
                if (rb.isProcessing) {
                    botStatus.push(`Reserve: TPA ${rb.currentRequest?.playerName || '...'}`);
                } else {
                    botStatus.push(`Reserve: Queue ${rb.queue.length}`);
                }
            }
            
            const popularList = popular.length > 0
                ? popular.map((s, i) => `**${i + 1}.** SM${s.sm} - ${s.avg} avg`).join('\n')
                : '*No data yet*';
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Live Metrics')
                .addFields(
                    { name: '🔥 Top Servers', value: popularList, inline: false },
                    { name: '👥 Players Tracked', value: `${totalPlayers}`, inline: true },
                    { name: '🔍 Total Scans', value: `${totalScans}`, inline: true },
                    { name: '🤖 Bots', value: botStatus.length > 0 ? botStatus.join('\n') : '*Offline*', inline: false }
                )
                .setColor(0x00AE86)
                .setFooter({ text: `Updated ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await message.edit({ embeds: [embed] });
            log('METRICS', 'Updated metrics embed');
        } catch (e) {
            log('METRICS', `Failed to update: ${e.message}`);
        }
    }
    
    // Resync all bots to their starting positions
    async resyncBots() {
        log('RESYNC', 'Resyncing cycling bots to starting positions...');
        
        for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
            const bot = this.bots[i];
            if (bot.isRunning && bot.isConnected) {
                await bot.goToLobby();
                bot.currentSm = CONFIG.BOT_STARTS[i];
                log('RESYNC', `Bot ${i} reset to sm${CONFIG.BOT_STARTS[i]}`);
                await sleep(1000);
            }
        }
        
        log('RESYNC', 'Resync complete');
    }
    
    // Check if user has role "A"
    hasRequiredRole(interaction) {
        const member = interaction.member;
        if (!member) return false;
        return member.roles.cache.some(role => role.name === REQUIRED_ROLE);
    }
    
    // Add a watch term
    addWatch(term) {
        const normalized = term.toLowerCase().replace(/\s+/g, '');
        // Check if already exists
        if (this.watchlist.some(w => w.normalized === normalized)) {
            return false;
        }
        this.watchlist.push({ original: term, normalized });
        this.saveWatchlist();
        return true;
    }
    
    // Remove a watch term
    removeWatch(term) {
        const normalized = term.toLowerCase().replace(/\s+/g, '');
        const before = this.watchlist.length;
        this.watchlist = this.watchlist.filter(w => w.normalized !== normalized);
        if (this.watchlist.length < before) {
            this.saveWatchlist();
            return true;
        }
        return false;
    }
    
    // Check if player name matches any watch term
    checkPlayerMatch(playerName) {
        const normalized = playerName.toLowerCase().replace(/\s+/g, '');
        
        for (const term of this.watchlist) {
            if (normalized.includes(term.normalized)) {
                return term.original;
            }
        }
        return null;
    }
    
    // Add a flag
    addFlag(playerName, userId) {
        const normalized = playerName.toLowerCase().replace(/\s+/g, '');
        this.flags.push({
            playerNormalized: normalized,
            playerOriginal: playerName,
            userId: userId,
            timestamp: Date.now()
        });
        this.saveFlags();
    }
    
    // Remove flags for a user
    removeUserFlags(userId) {
        const before = this.flags.length;
        const removed = this.flags.filter(f => f.userId === userId);
        this.flags = this.flags.filter(f => f.userId !== userId);
        if (this.flags.length < before) {
            this.saveFlags();
        }
        return removed;
    }
    
    // Check if player matches any flag
    checkFlagMatch(playerName) {
        const normalized = playerName.toLowerCase().replace(/\s+/g, '');
        
        const matches = [];
        for (const flag of this.flags) {
            if (normalized.includes(flag.playerNormalized) || flag.playerNormalized.includes(normalized)) {
                matches.push(flag);
            }
        }
        return matches;
    }
    
    // Remove a specific flag after alerting
    removeFlag(flag) {
        this.flags = this.flags.filter(f => 
            !(f.userId === flag.userId && f.playerNormalized === flag.playerNormalized)
        );
        this.saveFlags();
    }
    
    // Send flag alert
    async sendFlagAlert(playerName, num, flag, botId, type = 'sm') {
        if (!this.flagChannelId) return;
        const label = type === 'ps' ? `PS${num}` : `SM${num}`;
        
        try {
            const channel = await this.discord.channels.fetch(this.flagChannelId);
            
            // Calculate queue position
            const queuePos = this.reserveBot.queue.length + (this.reserveBot.isProcessing ? 1 : 0);
            const coordsStatus = queuePos > 0 
                ? `⏳ Awaiting TP accept... (Queue: #${queuePos + 1})`
                : `⏳ Awaiting TP accept...`;
            
            // Send message with coords field
            const message = await channel.send({
                content: `<@${flag.userId}>`,
                embeds: [new EmbedBuilder()
                    .setTitle('🚨  Flagged Player Located!')
                    .setDescription(
                        `### \`${playerName}\`\n` +
                        `> Spotted on **${label}** by **Bot ${botId}**`
                    )
                    .addFields(
                        { name: '🚩 Flagged As', value: `\`${flag.playerOriginal}\``, inline: true },
                        { name: '🤖 Detected By', value: `Bot ${botId}`, inline: true },
                        { name: '📍 Server', value: label, inline: true },
                        { name: '📌 Coordinates', value: coordsStatus, inline: false }
                    )
                    .setColor(0xED4245)
                    .setFooter({ text: 'TPA request queued — coords update automatically' })
                    .setTimestamp()]
            });
            
            // Queue TPA request
            const requestId = this.reserveBot.queueRequest(
                playerName,
                num,
                flag.userId,
                this.flagChannelId,
                message.id
            );
            
            this.tpaRequests.set(requestId, {
                channelId: this.flagChannelId,
                messageId: message.id,
                playerName,
                sm: num,
                userId: flag.userId
            });
            
            log('FLAG', `Alert sent for ${playerName}, TPA request queued (ID: ${requestId})`);
            
            // Remove the flag after alerting
            this.removeFlag(flag);
        } catch (e) {
            log('FLAG', `Failed to send flag alert: ${e.message}`);
        }
    }
    
    async sendAlert(playerName, num, matchedTerm, botId, type = 'sm') {
        if (!this.statusChannelId) return;
        const label = type === 'ps' ? `PS${num}` : `SM${num}`;
        
        try {
            const channel = await this.discord.channels.fetch(this.statusChannelId);
            
            const embed = new EmbedBuilder()
                .setTitle('🎯  Watchlist Match!')
                .setDescription(
                    `### \`${playerName}\`\n` +
                    `> Detected on **${label}** by **Bot ${botId}**`
                )
                .addFields(
                    { name: '🔍 Matched Term', value: `\`${matchedTerm}\``, inline: true },
                    { name: '🤖 Bot', value: `Bot ${botId}`, inline: true },
                    { name: '📍 Server', value: label, inline: true }
                )
                .setColor(0xFEE75C)
                .setFooter({ text: 'Watchlist alert' })
                .setTimestamp();
            
            await channel.send({ embeds: [embed] });
        } catch (e) {
            log('ALERT', `Failed to send alert: ${e.message}`);
        }
    }
    
    getChannelKey(sm) {
        const group = Math.ceil(sm / 10);
        const start = (group - 1) * 10 + 1;
        const end = group * 10;
        return `${start}-${end}`;
    }
    
    async createChannels(guild, category = null) {
        const channelGroups = [
            'sm1-10', 'sm11-20', 'sm21-30', 'sm31-40', 'sm41-50',
            'sm51-60', 'sm61-70', 'sm71-80', 'sm81-90'
        ];
        
        // Admin-only permissions (read for everyone, send for admins only)
        const adminOnlyPerms = [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.SendMessages],
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
            }
        ];
        
        // Create SM channels
        for (const name of channelGroups) {
            const key = name.replace('sm', '');
            
            const channel = await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: category,
                permissionOverwrites: adminOnlyPerms
            });
            
            this.channelIds[key] = channel.id;
            log('SETUP', `Created channel: ${name}`);
            
            // Create 10 messages for this channel
            const start = parseInt(key.split('-')[0]);
            const end = parseInt(key.split('-')[1]);
            
            for (let sm = start; sm <= end; sm++) {
                const embed = new EmbedBuilder()
                    .setTitle(`SM${sm}`)
                    .setDescription('*Waiting for scan...*')
                    .setColor(0x808080)
                    .setFooter({ text: 'Not yet scanned' });
                
                const msg = await channel.send({ embeds: [embed] });
                this.messageIds[sm] = msg.id;
            }
            
            // Create overflow message at the bottom
            const overflowEmbed = new EmbedBuilder()
                .setTitle('📦 Overflow')
                .setDescription('*No overflow*')
                .setColor(0x2F3136)
                .setFooter({ text: 'Players that didn\'t fit above' });
            
            const overflowMsg = await channel.send({ embeds: [overflowEmbed] });
            this.overflowIds[key] = overflowMsg.id;
            this.overflowData[key] = {};
        }
        
        // Create #statusmessages channel
        const statusChannel = await guild.channels.create({
            name: 'statusmessages',
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: adminOnlyPerms
        });
        this.statusChannelId = statusChannel.id;
        log('SETUP', 'Created channel: statusmessages');
        
        // Create #smresettimes channel
        const resetChannel = await guild.channels.create({
            name: 'smresettimes',
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: adminOnlyPerms
        });
        this.resetChannelId = resetChannel.id;
        log('SETUP', 'Created channel: smresettimes');
        
        // Create 90 messages for reset times
        for (let sm = 1; sm <= 90; sm++) {
            const embed = new EmbedBuilder()
                .setTitle(`SM${sm}`)
                .setDescription('*Not checked*')
                .setColor(0x808080);
            
            const msg = await resetChannel.send({ embeds: [embed] });
            this.resetMessageIds[sm] = msg.id;
        }
        
        // Create #pixelmonsurvival channel (PS1-24)
        const psChannel = await guild.channels.create({
            name: 'ps1-24',
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: adminOnlyPerms
        });
        this.psChannelId = psChannel.id;
        log('SETUP', 'Created channel: ps1-24');
        
        // Create 24 messages for PS servers
        for (let ps = 1; ps <= CONFIG.MAX_PS; ps++) {
            const embed = new EmbedBuilder()
                .setTitle(`PS${ps}`)
                .setDescription('*Waiting for scan...*')
                .setColor(0x808080)
                .setFooter({ text: 'Not yet scanned' });
            
            const msg = await psChannel.send({ embeds: [embed] });
            this.psMessageIds[ps] = msg.id;
        }
        
        // Overflow message for PS channel
        const psOverflowEmbed = new EmbedBuilder()
            .setTitle('📦 PS Overflow')
            .setDescription('*No overflow*')
            .setColor(0x2F3136)
            .setFooter({ text: 'PS players that didn\'t fit above' });
        const psOverflowMsg = await psChannel.send({ embeds: [psOverflowEmbed] });
        this.psOverflowId = psOverflowMsg.id;
        this.psOverflowData = {};
        
        // Create #flagplayer channel (PUBLIC - everyone can use /flag here)
        const flagChannel = await guild.channels.create({
            name: 'flagplayer',
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                    // No SendMessages deny - users use /flag command
                }
            ]
        });
        this.flagChannelId = flagChannel.id;
        log('SETUP', 'Created channel: flagplayer');
        
        // Send instructions to flagplayer
        await flagChannel.send({
            embeds: [new EmbedBuilder()
                .setTitle('🚩 Flag a Player')
                .setDescription('Use `/flag <username>` to flag a player.\nWhen they\'re found, you\'ll be pinged here!')
                .setColor(0xFF6600)]
        });
        
        this.saveMessageIds();
    }
    
    async updateOverflow(channelKey) {
        const channelId = this.channelIds[channelKey];
        const overflowMsgId = this.overflowIds[channelKey];
        const data = this.overflowData[channelKey] || {};
        
        if (!channelId || !overflowMsgId) return;
        
        try {
            const channel = await this.discord.channels.fetch(channelId);
            const message = await channel.messages.fetch(overflowMsgId);
            
            const entries = Object.entries(data).filter(([sm, players]) => players.length > 0);
            
            let embed;
            if (entries.length === 0) {
                embed = new EmbedBuilder()
                    .setTitle('📦 Overflow')
                    .setDescription('*No overflow*')
                    .setColor(0x2F3136)
                    .setFooter({ text: 'Players that didn\'t fit above' });
            } else {
                const lines = entries.map(([sm, players]) => {
                    const list = players.map(p => `\`${p}\``).join(', ');
                    return `**SM${sm}:** ${list}`;
                });
                
                embed = new EmbedBuilder()
                    .setTitle('📦 Overflow')
                    .setDescription(lines.join('\n').slice(0, 4000))
                    .setColor(0xFFAA00)
                    .setFooter({ text: `${entries.length} server(s) with overflow` });
            }
            
            await message.edit({ embeds: [embed] });
        } catch (e) {
            if (!isNetworkError(e)) {
                log('DASHBOARD', `Overflow update failed: ${e.message}`);
            }
        }
    }
    
    async updateDisplay(num, players, botId, type = 'sm') {
        const isPs = type === 'ps';
        const label = isPs ? `PS${num}` : `SM${num}`;
        
        // Route to correct channel/message
        let channelId, messageId;
        if (isPs) {
            channelId = this.psChannelId;
            messageId = this.psMessageIds[num];
        } else {
            const channelKey = this.getChannelKey(num);
            channelId = this.channelIds[channelKey];
            messageId = this.messageIds[num];
        }
        
        if (!channelId || !messageId) {
            log('DASHBOARD', `No message for ${label}`);
            return;
        }
        
        const channelKey = isPs ? 'ps' : this.getChannelKey(num);
        
        if (!isPs && !this.overflowData[channelKey]) {
            this.overflowData[channelKey] = {};
        }
        if (isPs && !this.psOverflowData) {
            this.psOverflowData = {};
        }
        
        // Check players against watchlist and flags
        if (players && players.length > 0) {
            for (const playerName of players) {
                this.trackPlayer(playerName, num, type);
                
                const match = this.checkPlayerMatch(playerName);
                if (match) {
                    await this.sendAlert(playerName, num, match, botId, type);
                }
                
                const flagMatches = this.checkFlagMatch(playerName);
                for (const flag of flagMatches) {
                    await this.sendFlagAlert(playerName, num, flag, botId, type);
                }
            }
            
            this.trackServer(`${type}-${num}`, players.length);
        } else if (players !== null) {
            this.trackServer(`${type}-${num}`, 0);
        }
        
        try {
            const channel = await this.discord.channels.fetch(channelId);
            const message = await channel.messages.fetch(messageId);
            
            let embed;
            let overflowPlayers = [];
            
            if (players === null) {
                embed = new EmbedBuilder()
                    .setTitle(`⛔  ${label}`)
                    .setDescription('```\nServer Unavailable\n```')
                    .setColor(0x2B2D31)
                    .setFooter({ text: `🤖 Bot ${botId}  •  ${new Date().toLocaleTimeString()}` });
                
                if (isPs) this.psOverflowData[num] = [];
                else this.overflowData[channelKey][num] = [];
            } else if (players.length === 0) {
                embed = new EmbedBuilder()
                    .setTitle(`🟡  ${label}`)
                    .setDescription('*No players online*')
                    .setColor(0xFEE75C)
                    .setFooter({ text: `🤖 Bot ${botId}  •  ${new Date().toLocaleTimeString()}` });
                
                if (isPs) this.psOverflowData[num] = [];
                else this.overflowData[channelKey][num] = [];
            } else {
                let displayPlayers = [...players];
                let playerList = displayPlayers.map(p => `\`${p}\``).join(', ');
                
                while (playerList.length > 3800 && displayPlayers.length > 1) {
                    overflowPlayers.unshift(displayPlayers.pop());
                    playerList = displayPlayers.map(p => `\`${p}\``).join(', ');
                }
                
                if (overflowPlayers.length > 0) {
                    playerList += `\n\n*+${overflowPlayers.length} more in overflow below*`;
                }
                
                embed = new EmbedBuilder()
                    .setTitle(`🟢  ${label}  ·  ${players.length} online`)
                    .setDescription(playerList)
                    .setColor(isPs ? 0x5865F2 : 0x57F287)
                    .setFooter({ text: `🤖 Bot ${botId}  •  ${new Date().toLocaleTimeString()}` });
                
                if (isPs) this.psOverflowData[num] = overflowPlayers;
                else this.overflowData[channelKey][num] = overflowPlayers;
            }
            
            await message.edit({ embeds: [embed] });
            
            // Update overflow
            if (isPs) {
                await this.updatePsOverflow();
            } else {
                await this.updateOverflow(channelKey);
            }
        } catch (e) {
            if (!isNetworkError(e)) {
                log('DASHBOARD', `Update ${label} failed: ${e.message}`);
            }
        }
    }
    
    async updatePsOverflow() {
        if (!this.psChannelId || !this.psOverflowId) return;
        
        try {
            const channel = await this.discord.channels.fetch(this.psChannelId);
            const message = await channel.messages.fetch(this.psOverflowId);
            
            const entries = Object.entries(this.psOverflowData || {}).filter(([, pl]) => pl.length > 0);
            
            let embed;
            if (entries.length === 0) {
                embed = new EmbedBuilder()
                    .setTitle('📦 PS Overflow')
                    .setDescription('*No overflow*')
                    .setColor(0x2F3136)
                    .setFooter({ text: 'PS players that didn\'t fit above' });
            } else {
                const lines = entries.map(([ps, pl]) => {
                    return `**PS${ps}:** ${pl.map(p => `\`${p}\``).join(', ')}`;
                });
                embed = new EmbedBuilder()
                    .setTitle('📦 PS Overflow')
                    .setDescription(lines.join('\n').slice(0, 4000))
                    .setColor(0xFFAA00)
                    .setFooter({ text: `${entries.length} PS server(s) with overflow` });
            }
            
            await message.edit({ embeds: [embed] });
        } catch (e) {
            if (!isNetworkError(e)) {
                log('DASHBOARD', `PS overflow update failed: ${e.message}`);
            }
        }
    }
    
    async registerCommands() {
        const commands = [
            { name: 'setup', description: 'Create dashboard channels (run once)' },
            { name: 'start', description: 'Start bots (4 cycling + 1 reserve for TPA)' },
            { name: 'stop', description: 'Stop all bots' },
            { name: 'status', description: 'View bot status' },
            { name: 'resets', description: 'Scan all servers for reset times' },
            { 
                name: 'flag', 
                description: 'Flag a player - get pinged when found',
                options: [{
                    name: 'username',
                    type: 3,
                    description: 'Player username to flag',
                    required: true
                }]
            },
            { name: 'unflag', description: 'Clear your flags' },
            { name: 'tpaqueue', description: 'View TPA request queue' },
            { 
                name: 'watch', 
                description: 'Add a term to the watchlist',
                options: [{
                    name: 'term',
                    type: 3,
                    description: 'Name/phrase/clantag to watch',
                    required: true
                }]
            },
            { 
                name: 'unwatch', 
                description: 'Remove a term from watchlist',
                options: [{
                    name: 'term',
                    type: 3,
                    description: 'Term to remove',
                    required: true
                }]
            },
            { name: 'watchlist', description: 'View all watch terms' },
            { 
                name: 'history', 
                description: 'View player history',
                options: [{
                    name: 'player',
                    type: 3,
                    description: 'Player name',
                    required: true
                }]
            },
            { name: 'popular', description: 'View most popular servers' },
            { name: 'save', description: 'Force save all data' },
            {
                name: 'alts',
                description: 'Look up linked accounts for a player',
                options: [{
                    name: 'player',
                    type: 3,
                    description: 'Player name to check',
                    required: true
                }]
            },
            { name: 'devices', description: 'View device tracking stats' },
            {
                name: 'setmetrics',
                description: 'Set the metrics channel',
                options: [{
                    name: 'channel',
                    type: 7,
                    description: 'Channel for metrics embed',
                    required: true
                }]
            },
            { name: 'resync', description: 'Resync all bots to starting positions' },
            {
                name: 'keyword',
                description: 'Search all scanned players by IGN keyword',
                options: [{
                    name: 'term',
                    type: 3,
                    description: 'Keyword to search in player IGNs (e.g. IMP)',
                    required: true
                }]
            },
            {
                name: 'transfer',
                description: 'Manually transfer a bot to a server',
                options: [
                    {
                        name: 'bot',
                        type: 4,
                        description: 'Bot number (1-5)',
                        required: true,
                        min_value: 1,
                        max_value: 10
                    },
                    {
                        name: 'server',
                        type: 3,
                        description: 'Server name e.g. sm5 or ps3',
                        required: true
                    }
                ]
            }
        ];
        
        await this.discord.application.commands.set([]);
        for (const guild of this.discord.guilds.cache.values()) {
            try {
                await guild.commands.set(commands);
                log('DISCORD', `Registered commands in ${guild.name}`);
            } catch (e) {
                log('DISCORD', `Command registration failed: ${e.message}`);
            }
        }
    }
    
    async handleButtonInteraction(interaction) {
        const { customId } = interaction;
        
        if (customId === 'auth_confirm_start') {
            this.authConfirmPending = false;
            this.authPendingBots = {};
            
            await interaction.update({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Starting Scan')
                    .setDescription('Bots are now beginning to scan survival mode servers...')
                    .setColor(0x57F287)
                    .setTimestamp()],
                components: []
            });
            
            // Start cycling bots
            for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                if (!this.bots[i].isRunning) {
                    this.bots[i].startCycling();
                    await sleep(CONFIG.CONNECT_STAGGER);
                }
            }
            this.reserveBot.startProcessing();
            
        } else if (customId === 'auth_confirm_abort') {
            this.authConfirmPending = false;
            this.authPendingBots = {};
            
            // Stop any bots that may have partially connected
            for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                if (this.bots[i].isRunning || this.bots[i].isConnected) {
                    this.bots[i].stop?.();
                }
            }
            
            await interaction.update({
                embeds: [new EmbedBuilder()
                    .setTitle('⛔ Aborted')
                    .setDescription('Bot start was cancelled. Use `/start` to try again.')
                    .setColor(0xED4245)
                    .setTimestamp()],
                components: []
            });
        }
    }
    
    async handleCommand(interaction) {
        const { commandName, guild } = interaction;
        
        // Commands anyone can use
        const publicCommands = ['flag', 'unflag', 'history', 'alts', 'devices', 'popular', 'tpaqueue', 'keyword'];
        
        // Check for required role (skip for public commands)
        if (!publicCommands.includes(commandName) && !this.hasRequiredRole(interaction)) {
            return interaction.reply({ 
                content: '❌ You need the **A** role to use this bot.', 
                ephemeral: true 
            });
        }
        
        try {
            switch (commandName) {
                case 'setup': {
                    if (Object.keys(this.messageIds).length > 0) {
                        return interaction.reply({ 
                            content: 'Dashboard already set up! Delete the channels and `message_ids.json` to reset.', 
                            ephemeral: true 
                        });
                    }
                    
                    await interaction.deferReply();
                    
                    // Create category
                    const category = await guild.channels.create({
                        name: 'SM Dashboard',
                        type: ChannelType.GuildCategory
                    });
                    
                    await this.createChannels(guild, category.id);
                    
                    await interaction.editReply('✅ Dashboard created! 9 channels with 90 server displays ready.');
                    break;
                }
                
                case 'start': {
                    if (Object.keys(this.messageIds).length === 0) {
                        return interaction.reply({ content: '❌ Run `/setup` first!', ephemeral: true });
                    }
                    
                    if (this.authConfirmPending) {
                        return interaction.reply({ content: '⏳ Auth flow already in progress. Complete or abort it first.', ephemeral: true });
                    }
                    
                    // Check if bots already have saved tokens (auth folder exists + has tokens)
                    const botsNeedingAuth = [];
                    for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                        const folder = XBOX_AUTH[`BOT${i}`];
                        const hasToken = fs.existsSync(folder) && 
                            fs.readdirSync(folder).some(f => f.endsWith('.json'));
                        if (!hasToken) botsNeedingAuth.push(i);
                    }
                    
                    if (botsNeedingAuth.length > 0) {
                        // Some bots need auth — show the flow
                        this.authPendingBots = {};
                        this.authConfirmPending = false;
                        
                        const botList = botsNeedingAuth.map(i => `> 🤖 **Bot ${i}**`).join('\n');
                        
                        await interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setTitle('🔐 Microsoft Authentication Required')
                                .setDescription(
                                    `**${botsNeedingAuth.length}** bot(s) need to sign in to Xbox Live:\n${botList}\n\n` +
                                    `Auth links will appear below as each bot requests them.\n` +
                                    `After all links are posted, you'll be asked to confirm before scanning starts.`
                                )
                                .setColor(0x5865F2)
                                .setFooter({ text: 'Each bot needs a separate Microsoft account' })
                                .setTimestamp()
                        ]});
                        
                        // Connect bots that need auth (staggered so MSA codes appear one by one)
                        for (const i of botsNeedingAuth) {
                            if (!this.bots[i].isRunning) {
                                this.bots[i].connect(); // Don't await — MSA callback fires async
                                await sleep(CONFIG.CONNECT_STAGGER);
                            }
                        }
                        
                        // If all bots already have tokens but some still needed auth above - 
                        // after connect() calls the join event fires - startCycling happens via confirm button
                    } else {
                        // All bots have tokens — skip auth, ask for confirmation directly
                        await interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setTitle('✅ All Accounts Authenticated')
                                .setDescription(
                                    `All **${CONFIG.CYCLING_BOTS}** bots have saved login tokens.\n\n` +
                                    `Ready to start scanning **${CONFIG.MAX_SM}** survival mode servers.\n` +
                                    `Press **▶ Start Scanning** to begin or **✖ Abort** to cancel.`
                                )
                                .setColor(0x57F287)
                                .setTimestamp()
                        ]});
                        
                        // Send confirm embed to the reply channel
                        const replyMsg = await interaction.fetchReply();
                        const channel = await this.discord.channels.fetch(replyMsg.channelId);
                        this.authConfirmPending = true;
                        await this.sendAuthConfirmPrompt(channel);
                    }
                    
                    break;
                }
                
                case 'stop': {
                    // Stop cycling bots
                    for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                        this.bots[i].stop();
                    }
                    // Disconnect reserve bot
                    await this.reserveBot.disconnect();
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('⏹️  Bots Stopped')
                            .setDescription('All cycling and reserve bots have been stopped.')
                            .setColor(0xED4245)
                            .setTimestamp()
                    ]});
                    break;
                }
                
                case 'status': {
                    const lines = [];
                    
                    // Cycling bots status
                    for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                        const b = this.bots[i];
                        let status = '⚪ Offline';
                        if (b.isRunning) {
                            if (b.scanningPs) {
                                status = `🔵 Scanning PS${b.currentPs}`;
                            } else {
                                status = `🟢 Scanning SM${b.currentSm}`;
                            }
                        } else if (b.isConnected) status = '🔵 Idle';
                        
                        lines.push(`**Bot ${i}** ${b.gamertag ? `(${b.gamertag})` : ''}: ${status}`);
                    }
                    
                    // Reserve bot status
                    const rb = this.reserveBot;
                    let reserveStatus = '⚪ Offline';
                    if (rb.isProcessing) {
                        reserveStatus = `🟡 Processing TPA for ${rb.currentRequest?.playerName || 'unknown'}`;
                    } else if (rb.isConnected) {
                        reserveStatus = `🔵 Idle (Queue: ${rb.queue.length})`;
                    } else if (rb.queue.length > 0) {
                        reserveStatus = `⏳ Queue: ${rb.queue.length} pending`;
                    }
                    lines.push(`**Reserve Bot** ${rb.gamertag ? `(${rb.gamertag})` : ''}: ${reserveStatus}`);
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('📡  Bot Status')
                            .setDescription(lines.join('\n'))
                            .setColor(0x5865F2)
                            .setFooter({ text: `${CONFIG.TOTAL_BOTS} bots total  •  ${CONFIG.CYCLING_BOTS} cycling  •  1 reserve` })
                            .setTimestamp()
                    ]});
                    break;
                }
                
                case 'flag': {
                    const username = interaction.options.getString('username');
                    const userId = interaction.user.id;
                    
                    this.addFlag(username, userId);
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setDescription(`🚩 Flagged **${username}**\nYou'll be pinged when they're found!`)
                            .setColor(0x00FF00)
                    ]});
                    break;
                }
                
                case 'unflag': {
                    const userId = interaction.user.id;
                    const removed = this.removeUserFlags(userId);
                    
                    if (removed.length === 0) {
                        return interaction.reply({ 
                            content: 'You have no active flags.', 
                            ephemeral: true 
                        });
                    }
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setDescription(`✅ Cleared ${removed.length} flag(s):\n${removed.map(f => `\`${f.playerOriginal}\``).join(', ')}`)
                            .setColor(0x00FF00)
                    ]});
                    break;
                }
                
                case 'tpaqueue': {
                    const rb = this.reserveBot;
                    const queueList = rb.queue.map((req, i) => 
                        `**${i + 1}.** ${req.playerName} (SM${req.sm}) - ${timeAgo(req.timestamp)}`
                    );
                    
                    let status = '⚪ Offline';
                    if (rb.isProcessing && rb.currentRequest) {
                        status = `🟡 Processing: **${rb.currentRequest.playerName}** on SM${rb.currentRequest.sm}`;
                    } else if (rb.isConnected) {
                        status = '🟢 Idle - waiting for requests';
                    }
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('📋 TPA Request Queue')
                            .addFields(
                                { name: 'Reserve Bot Status', value: status, inline: false },
                                { name: `Queue (${rb.queue.length})`, value: queueList.length > 0 ? queueList.join('\n') : '*Empty*', inline: false }
                            )
                            .setColor(0x00AE86)
                            .setTimestamp()
                    ]});
                    break;
                }
                
                case 'watch': {
                    const term = interaction.options.getString('term');
                    
                    if (this.addWatch(term)) {
                        await interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setDescription(`✅ Added **${term}** to watchlist`)
                                .setColor(0x00FF00)
                        ]});
                    } else {
                        await interaction.reply({ content: 'Already watching that term.', ephemeral: true });
                    }
                    break;
                }
                
                case 'unwatch': {
                    const term = interaction.options.getString('term');
                    
                    if (this.removeWatch(term)) {
                        await interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setDescription(`✅ Removed **${term}** from watchlist`)
                                .setColor(0x00FF00)
                        ]});
                    } else {
                        await interaction.reply({ content: 'Term not found in watchlist.', ephemeral: true });
                    }
                    break;
                }
                
                case 'watchlist': {
                    if (this.watchlist.length === 0) {
                        return interaction.reply({ 
                            content: 'Watchlist is empty. Use `/watch <term>` to add.', 
                            ephemeral: true 
                        });
                    }
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('📋 Watchlist')
                            .setDescription(this.watchlist.map(w => `\`${w.original}\``).join(', '))
                            .setFooter({ text: `${this.watchlist.length} term(s)` })
                            .setColor(0x00AE86)
                    ]});
                    break;
                }
                
                case 'history': {
                    const playerName = interaction.options.getString('player');
                    const data = this.getPlayerHistory(playerName);
                    
                    if (!data) {
                        return interaction.reply({ 
                            content: `No data for **${playerName}**`, 
                            ephemeral: true 
                        });
                    }
                    
                    // Current location
                    const current = data.current 
                        ? `${data.current.type === 'ps' ? 'PS' : 'SM'}${data.current.sm} (${timeAgo(data.current.time)})` 
                        : 'Unknown';
                    
                    // Recent history (last 5)
                    const history = data.history.slice(0, 5)
                        .map(h => `${h.type === 'ps' ? 'PS' : 'SM'}${h.sm}`)
                        .join(' → ') || 'None';
                    
                    // Top servers
                    const topServers = Object.entries(data.servers)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([key, count]) => `${key.toUpperCase()}: ${count}x`)
                        .join(', ') || 'None';
                    
                    // Device info
                    const platform = data.buildPlatform 
                        ? this.getPlatformName(data.buildPlatform) 
                        : 'Unknown';
                    const deviceShort = data.deviceId 
                        ? `${data.deviceId.substring(0, 8)}...` 
                        : 'Unknown';
                    
                    // Get alts
                    const alts = this.getPlayerAlts(playerName);
                    const altsStr = alts.length > 0 
                        ? alts.map(a => `\`${a}\``).join(', ')
                        : '*None detected*';
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`📊 ${data.name}`)
                        .addFields(
                            { name: 'Current', value: current, inline: true },
                            { name: 'Platform', value: platform, inline: true },
                            { name: 'Recent', value: history, inline: false },
                            { name: 'Top Servers', value: topServers, inline: false }
                        )
                        .setColor(0x00AE86);
                    
                    // Add alts field if there's device data
                    if (data.deviceId) {
                        embed.addFields({ 
                            name: `🔗 Linked Accounts (${deviceShort})`, 
                            value: altsStr, 
                            inline: false 
                        });
                    }
                    
                    await interaction.reply({ embeds: [embed] });
                    break;
                }
                
                case 'popular': {
                    const popular = this.getPopularServers().slice(0, 10);
                    
                    if (popular.length === 0) {
                        return interaction.reply({ 
                            content: 'No data yet. Start scanning first!', 
                            ephemeral: true 
                        });
                    }
                    
                    const list = popular.map((s, i) => 
                        `**${i + 1}.** SM${s.sm} - ${s.avg} avg (${s.scans} scans)`
                    ).join('\n');
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('🔥 Most Popular Servers')
                            .setDescription(list)
                            .setFooter({ text: 'By average player count' })
                            .setColor(0xFF6600)
                    ]});
                    break;
                }
                
                case 'alts': {
                    const playerName = interaction.options.getString('player');
                    const key = playerName.toLowerCase();
                    const player = this.players[key];
                    
                    if (!player) {
                        return interaction.reply({ 
                            content: `No data for **${playerName}**`, 
                            ephemeral: true 
                        });
                    }
                    
                    if (!player.deviceId) {
                        return interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setTitle(`🔗 ${player.name}`)
                                .setDescription('*No device ID captured yet*\nThey need to be scanned by a bot in-game to capture device info.')
                                .setColor(0x808080)
                        ]});
                    }
                    
                    const alts = this.getPlayerAlts(playerName);
                    const platform = this.getPlatformName(player.buildPlatform);
                    const deviceShort = player.deviceId.substring(0, 12);
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`🔗 ${player.name}`)
                        .addFields(
                            { name: 'Platform', value: platform, inline: true },
                            { name: 'Device ID', value: `\`${deviceShort}...\``, inline: true }
                        )
                        .setColor(alts.length > 0 ? 0xFF6600 : 0x00AE86);
                    
                    if (alts.length > 0) {
                        embed.addFields({
                            name: `⚠️ Linked Accounts (${alts.length})`,
                            value: alts.map(a => `• \`${a}\``).join('\n'),
                            inline: false
                        });
                    } else {
                        embed.addFields({
                            name: 'Linked Accounts',
                            value: '*None detected - only account on this device*',
                            inline: false
                        });
                    }
                    
                    await interaction.reply({ embeds: [embed] });
                    break;
                }
                
                case 'devices': {
                    const totalPlayers = Object.keys(this.players).length;
                    const playersWithDevice = Object.values(this.players).filter(p => p.deviceId).length;
                    const totalDevices = Object.keys(this.sharedAccounts).length;
                    const sharedDevices = Object.entries(this.sharedAccounts)
                        .filter(([_, players]) => players.length > 1);
                    
                    // Top shared devices
                    const topShared = sharedDevices
                        .sort((a, b) => b[1].length - a[1].length)
                        .slice(0, 5)
                        .map(([deviceId, players]) => {
                            const names = players.map(p => this.players[p]?.name || p);
                            return `**${players.length} accounts:** ${names.join(', ')}`;
                        });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('📱 Device Tracking Stats')
                        .addFields(
                            { name: 'Players Tracked', value: `${totalPlayers}`, inline: true },
                            { name: 'With Device ID', value: `${playersWithDevice}`, inline: true },
                            { name: 'Unique Devices', value: `${totalDevices}`, inline: true },
                            { name: 'Shared Devices', value: `${sharedDevices.length}`, inline: true }
                        )
                        .setColor(0x00AE86);
                    
                    if (topShared.length > 0) {
                        embed.addFields({
                            name: '🔗 Top Shared Devices',
                            value: topShared.join('\n') || '*None*',
                            inline: false
                        });
                    }
                    
                    await interaction.reply({ embeds: [embed] });
                    break;
                }
                
                case 'save': {
                    this.savePlayers();
                    this.saveMetrics();
                    this.saveWatchlist();
                    this.saveFlags();
                    this.saveSharedAccounts();
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setDescription('✅ All data saved')
                            .setColor(0x00FF00)
                    ]});
                    break;
                }
                
                case 'setmetrics': {
                    const channel = interaction.options.getChannel('channel');
                    
                    // Create initial embed in the channel
                    const embed = new EmbedBuilder()
                        .setTitle('📊 Live Metrics')
                        .setDescription('*Waiting for data...*')
                        .setColor(0x00AE86)
                        .setFooter({ text: 'Updates every 30 minutes' });
                    
                    const msg = await channel.send({ embeds: [embed] });
                    
                    this.metricsChannelId = channel.id;
                    this.metricsMessageId = msg.id;
                    this.saveMessageIds();
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setDescription(`✅ Metrics linked to ${channel}`)
                            .setColor(0x00FF00)
                    ]});
                    
                    // Update immediately
                    await this.updateMetricsEmbed();
                    break;
                }
                
                case 'resync': {
                    await interaction.deferReply();
                    await this.resyncBots();
                    await interaction.editReply({ embeds: [
                        new EmbedBuilder()
                            .setDescription('✅ All bots resynced to starting positions')
                            .setColor(0x00FF00)
                    ]});
                    break;
                }
                
                case 'keyword': {
                    const term = interaction.options.getString('term').toLowerCase();
                    const results = [];
                    
                    for (const [key, player] of Object.entries(this.players)) {
                        if (key.includes(term) || player.name.toLowerCase().includes(term)) {
                            const lastSeen = player.current
                                ? `SM${player.current.sm} — ${timeAgo(player.current.time)}`
                                : (player.history.length > 0
                                    ? `Last: SM${player.history[0].sm} (${timeAgo(player.history[0].time)})`
                                    : 'No location data');
                            
                            // Duration: time between first and last sighting on current/last server
                            let duration = '';
                            if (player.history.length >= 2) {
                                const diff = Math.abs(player.history[0].time - player.history[player.history.length - 1].time);
                                const mins = Math.floor(diff / 60000);
                                const hrs = Math.floor(mins / 60);
                                if (hrs > 0) duration = ` (tracked ${hrs}h ${mins % 60}m)`;
                                else if (mins > 0) duration = ` (tracked ${mins}m)`;
                            }
                            
                            const platform = player.buildPlatform ? ` • ${this.getPlatformName(player.buildPlatform)}` : '';
                            results.push({ name: player.name, info: `${lastSeen}${duration}${platform}` });
                        }
                    }
                    
                    if (results.length === 0) {
                        return interaction.reply({ embeds: [
                            new EmbedBuilder()
                                .setTitle(`🔍 Keyword: \`${term}\``)
                                .setDescription('*No players found matching that keyword.*')
                                .setColor(0x808080)
                                .setTimestamp()
                        ]});
                    }
                    
                    // Sort by most recently seen
                    results.sort((a, b) => {
                        const pa = this.players[a.name.toLowerCase()];
                        const pb = this.players[b.name.toLowerCase()];
                        const ta = pa?.current?.time || pa?.history?.[0]?.time || 0;
                        const tb = pb?.current?.time || pb?.history?.[0]?.time || 0;
                        return tb - ta;
                    });
                    
                    const MAX_DISPLAY = 20;
                    const shown = results.slice(0, MAX_DISPLAY);
                    const overflow = results.length - shown.length;
                    
                    const lines = shown.map((r, i) => `**${i + 1}.** \`${r.name}\`\n> ${r.info}`).join('\n\n');
                    const footer = overflow > 0 ? `\n\n*...and ${overflow} more*` : '';
                    
                    await interaction.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle(`🔍 Keyword Search: \`${term}\``)
                            .setDescription((lines + footer).slice(0, 4000))
                            .setColor(0x5865F2)
                            .setFooter({ text: `${results.length} player(s) found matching "${term}"` })
                            .setTimestamp()
                    ]});
                    break;
                }
                
                case 'transfer': {
                    const botNum = interaction.options.getInteger('bot');
                    const serverRaw = interaction.options.getString('server').toLowerCase().trim();
                    
                    // Determine target server type: smX or psX
                    const smMatch = serverRaw.match(/^sm(\d+)$/);
                    const psMatch = serverRaw.match(/^ps(\d+)$/);
                    
                    if (!smMatch && !psMatch) {
                        return interaction.reply({ 
                            content: '❌ Invalid server format. Use `sm5` or `ps3`.', 
                            ephemeral: true 
                        });
                    }
                    
                    const serverNum = parseInt((smMatch || psMatch)[1]);
                    const serverType = smMatch ? 'sm' : 'ps';
                    const serverLabel = `${serverType.toUpperCase()}${serverNum}`;
                    
                    const bot = this.bots[botNum];
                    if (!bot) {
                        return interaction.reply({ content: `❌ Bot ${botNum} doesn't exist.`, ephemeral: true });
                    }
                    if (!bot.isConnected || !bot.client) {
                        return interaction.reply({ content: `❌ Bot ${botNum} is not connected.`, ephemeral: true });
                    }
                    
                    await interaction.deferReply();
                    
                    // Send the transfer command
                    const cmd = `/${serverType} ${serverType}${serverNum}`;
                    bot.client.queue('text', {
                        type: 'chat',
                        needs_translation: false,
                        source_name: bot.client.profile?.name || 'Player',
                        xuid: bot.client.profile?.xuid || '',
                        platform_chat_id: '',
                        message: cmd,
                        filtered_message: ''
                    });
                    
                    log('TRANSFER', `Manually transferred Bot${botNum} to ${serverLabel}`);
                    
                    await interaction.editReply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('📡 Transfer Sent')
                            .setDescription(`**Bot ${botNum}** (`+`${bot.gamertag || 'Unknown'}` +`) → **${serverLabel}**`)
                            .addFields(
                                { name: 'Command', value: `\`${cmd}\``, inline: true },
                                { name: 'Previous', value: bot.currentServer ? `SM${bot.currentServer}` : 'Lobby', inline: true }
                            )
                            .setColor(0x5865F2)
                            .setTimestamp()
                    ]});
                    break;
                }
                
                case 'resets': {
                    if (!this.resetChannelId) {
                        return interaction.reply({ content: 'Run /setup first!', ephemeral: true });
                    }
                    
                    if (this.resetScanActive) {
                        return interaction.reply({ content: 'Reset scan already in progress!', ephemeral: true });
                    }
                    
                    await interaction.deferReply();
                    
                    // Stop cycling bots (reserve can keep working)
                    for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
                        this.bots[i].stop();
                    }
                    
                    await interaction.editReply('⏳ Starting reset time scan... (this may take a while)');
                    
                    // Start reset scan
                    this.resetScanActive = true;
                    this.resetScanChecked = new Set();
                    
                    this.runResetScan().then(() => {
                        this.resetScanActive = false;
                        log('RESETS', 'Reset scan complete');
                    }).catch(e => {
                        this.resetScanActive = false;
                        log('RESETS', `Reset scan failed: ${e.message}`);
                    });
                    
                    break;
                }
            }
        } catch (e) {
            log('CMD', `Error: ${e.message}`);
            try {
                if (interaction.deferred) {
                    await interaction.editReply(`Error: ${e.message}`);
                } else {
                    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
                }
            } catch {}
        }
    }
    
    // Parse time string like "5 days 7 hours 59 minutes"
    parseTimeUntilReset(text) {
        const days = text.match(/(\d+)\s*days?/i)?.[1] || 0;
        const hours = text.match(/(\d+)\s*hours?/i)?.[1] || 0;
        const minutes = text.match(/(\d+)\s*minutes?/i)?.[1] || 0;
        
        return {
            days: parseInt(days),
            hours: parseInt(hours),
            minutes: parseInt(minutes)
        };
    }
    
    // Calculate reset datetime
    calculateResetTime(timeStr) {
        const parsed = this.parseTimeUntilReset(timeStr);
        const now = new Date();
        
        const resetTime = new Date(now.getTime() + 
            (parsed.days * 24 * 60 * 60 * 1000) +
            (parsed.hours * 60 * 60 * 1000) +
            (parsed.minutes * 60 * 1000)
        );
        
        return resetTime;
    }
    
    // Update reset time message
    async updateResetMessage(sm, timeStr) {
        const messageId = this.resetMessageIds[sm];
        if (!messageId || !this.resetChannelId) return;
        
        try {
            const channel = await this.discord.channels.fetch(this.resetChannelId);
            const message = await channel.messages.fetch(messageId);
            
            const resetTime = this.calculateResetTime(timeStr);
            const timestamp = Math.floor(resetTime.getTime() / 1000);
            
            const embed = new EmbedBuilder()
                .setTitle(`SM${sm}`)
                .setDescription(`Resets: <t:${timestamp}:F>\n(<t:${timestamp}:R>)`)
                .setColor(0x00AE86)
                .setFooter({ text: `Raw: ${timeStr}` });
            
            await message.edit({ embeds: [embed] });
        } catch (e) {
            log('RESETS', `Failed to update sm${sm}: ${e.message}`);
        }
    }
    
    // Run reset scan across all servers
    async runResetScan() {
        log('RESETS', 'Starting reset scan...');
        
        // Connect cycling bots
        for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
            if (!this.bots[i].isConnected) {
                await this.bots[i].connect();
                await sleep(2000);
            }
        }
        
        // Assign servers to bots (4 bots across 90 servers)
        const assignments = {};
        for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
            assignments[i] = [];
        }
        for (let sm = 1; sm <= 90; sm++) {
            const botNum = ((sm - 1) % CONFIG.CYCLING_BOTS) + 1;
            assignments[botNum].push(sm);
        }
        
        // Run all bots in parallel
        const promises = [];
        for (let botId = 1; botId <= CONFIG.CYCLING_BOTS; botId++) {
            promises.push(this.runBotResetScan(botId, assignments[botId]));
        }
        
        await Promise.all(promises);
        log('RESETS', 'All bots finished reset scan');
    }
    
    // Run reset scan for a single bot
    async runBotResetScan(botId, servers) {
        const bot = this.bots[botId];
        
        for (const sm of servers) {
            if (this.resetScanChecked.has(sm)) continue;
            
            log('RESETS', `Bot${botId} checking sm${sm}`);
            
            // Transfer to server
            const success = await bot.transferTo(sm);
            if (!success) {
                // Mark as unavailable
                try {
                    const channel = await this.discord.channels.fetch(this.resetChannelId);
                    const message = await channel.messages.fetch(this.resetMessageIds[sm]);
                    await message.edit({ embeds: [
                        new EmbedBuilder()
                            .setTitle(`SM${sm}`)
                            .setDescription('*Server unavailable*')
                            .setColor(0xFF6600)
                    ]});
                } catch {}
                
                this.resetScanChecked.add(sm);
                continue;
            }
            
            await sleep(500);
            
            // Run /servertime command
            const timeStr = await this.runServerTimeCommand(bot);
            
            if (timeStr) {
                await this.updateResetMessage(sm, timeStr);
            }
            
            this.resetScanChecked.add(sm);
            await sleep(CONFIG.CYCLE_DELAY);
            
            // Reset if too many failures
            if (bot.consecutiveFailures >= CONFIG.MAX_FAILURES) {
                await bot.goToLobby();
                bot.consecutiveFailures = 0;
                await sleep(3000);
            }
        }
        
        await bot.goToLobby();
    }
    
    // Run /servertime and capture response
    async runServerTimeCommand(bot) {
        return new Promise(resolve => {
            let resolved = false;
            
            const handler = (packet) => {
                const msg = packet.message || '';
                // Look for "Time until restart: X days Y hours Z minutes"
                if (msg.includes('Time until restart:')) {
                    if (!resolved) {
                        resolved = true;
                        bot.client.removeListener('text', handler);
                        resolve(msg.replace('Time until restart:', '').trim());
                    }
                }
            };
            
            bot.client.on('text', handler);
            
            // Send /servertime command using text packet
            bot.client.queue('text', {
                type: 'chat',
                needs_translation: false,
                source_name: bot.client.profile?.name || 'Player',
                xuid: bot.client.profile?.xuid || '',
                platform_chat_id: '',
                message: '/servertime',
                filtered_message: ''
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    bot.client.removeListener('text', handler);
                    resolve(null);
                }
            }, 5000);
        });
    }
    
    // Handle MSA auth code from a bot
    async handleMsaCode(botId, url, code) {
        this.authPendingBots[botId] = { url, code, status: 'pending' };
        
        // Find the input channel to post the auth link
        const targetChannelId = this.inputChannelId || this.statusChannelId;
        if (!targetChannelId) return;
        
        try {
            const channel = await this.discord.channels.fetch(targetChannelId);
            
            const embed = new EmbedBuilder()
                .setTitle(`🔐 Bot ${botId} — Microsoft Authentication Required`)
                .setDescription(
                    `**Bot ${botId}** needs to sign in to Xbox Live.\n\n` +
                    `> **Step 1:** Click the button below to open Microsoft's login page\n` +
                    `> **Step 2:** Enter the code shown below\n` +
                    `> **Step 3:** Complete sign-in with your Xbox account`
                )
                .addFields(
                    { name: '🔑 Auth Code', value: `\`\`\`${code}\`\`\``, inline: true },
                    { name: '⏳ Status', value: '`Awaiting login...`', inline: true }
                )
                .setColor(0x5865F2)
                .setFooter({ text: `Bot ${botId} of ${CONFIG.TOTAL_BOTS} • Link expires in ~15 minutes` })
                .setTimestamp();
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel(`Login for Bot ${botId}`)
                    .setStyle(ButtonStyle.Link)
                    .setURL(url)
                    .setEmoji('🔗')
            );
            
            await channel.send({ embeds: [embed], components: [row] });
            log('AUTH', `Posted auth link for Bot ${botId}`);
            
            // Check if all bots have posted their codes
            const pendingCount = Object.keys(this.authPendingBots).length;
            if (pendingCount >= CONFIG.CYCLING_BOTS && !this.authConfirmPending) {
                this.authConfirmPending = true;
                await sleep(2000);
                await this.sendAuthConfirmPrompt(channel);
            }
        } catch (e) {
            log('AUTH', `Failed to post auth link: ${e.message}`);
        }
    }
    
    // Send the final Yes/No prompt after all auth links are shown
    async sendAuthConfirmPrompt(channel) {
        const allBotLines = Object.entries(this.authPendingBots)
            .map(([id, d]) => `> 🤖 **Bot ${id}** — [Login Link](${d.url}) | Code: \`${d.code}\``)
            .join('\n');
        
        const embed = new EmbedBuilder()
            .setTitle('🚀 All Auth Links Sent')
            .setDescription(
                `All **${CONFIG.CYCLING_BOTS}** bots have requested authentication.\n\n` +
                `${allBotLines}\n\n` +
                `Once you've completed the logins above, click **▶ Start Scanning** to begin.\n` +
                `Click **✖ Abort** to cancel and wait for \`/start\` again.`
            )
            .setColor(0xFEE75C)
            .setFooter({ text: 'Make sure all accounts are logged in before starting!' })
            .setTimestamp();
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('auth_confirm_start')
                .setLabel('▶ Start Scanning')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('auth_confirm_abort')
                .setLabel('✖ Abort')
                .setStyle(ButtonStyle.Danger)
        );
        
        await channel.send({ embeds: [embed], components: [row] });
    }
    
    async start() {
        this.discord.on('ready', async () => {
            log('DISCORD', `Logged in as ${this.discord.user.tag}`);
            await this.registerCommands();
            log('DISCORD', 'Ready! Use /setup then /start');
            
            // Auto-save every 60 seconds
            setInterval(() => {
                this.savePlayers();
                this.saveMetrics();
                this.saveSharedAccounts();
            }, 60000);
            
            // Update metrics embed every 30 mins
            setInterval(() => {
                this.updateMetricsEmbed();
            }, CONFIG.METRICS_UPDATE);
            
            // Resync bots every 90 mins
            setInterval(() => {
                if (!this.resetScanActive) {
                    this.resyncBots();
                }
            }, CONFIG.BOT_RESYNC);
        });
        
        this.discord.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                await this.handleButtonInteraction(interaction);
                return;
            }
            if (!interaction.isChatInputCommand()) return;
            await this.handleCommand(interaction);
        });
        
        await this.discord.login(DISCORD_TOKEN);
    }
    
    async shutdown() {
        log('MAIN', 'Shutting down...');
        // Save all data
        this.savePlayers();
        this.saveMetrics();
        this.saveWatchlist();
        this.saveFlags();
        this.saveSharedAccounts();
        
        // Disconnect cycling bots
        for (let i = 1; i <= CONFIG.CYCLING_BOTS; i++) {
            await this.bots[i].disconnect();
        }
        
        // Disconnect reserve bot
        await this.reserveBot.disconnect();
        
        this.discord.destroy();
    }
}
 
// ============================================
// MAIN
// ============================================
const dashboard = new Dashboard();
 
process.on('SIGINT', async () => {
    await dashboard.shutdown();
    process.exit(0);
});
 
process.on('SIGTERM', async () => {
    await dashboard.shutdown();
    process.exit(0);
});
 
dashboard.start().catch(e => {
    console.error('Failed to start:', e);
    process.exit(1);
});
