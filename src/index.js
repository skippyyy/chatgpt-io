const uuid = require("uuid");
const io = require("socket.io-client");
const {getOpenAIAuth} = require('./auth');

class ChatGPT {
	constructor(
        options,
        bypassNode = "https://gpt.pawan.krd"
        ) {
        Object.freeze(options);
		this.ready = false;
		this.socket = io.connect(bypassNode, {
			pingInterval: 10000,
			pingTimeout: 5000,
			reconnection: true,
			reconnectionAttempts: 1000,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			timeout: 10000,
			transports: ["websocket", "polling"],
			upgrade: false,
			forceNew: true,
		});
		this.sessionToken = options.sessionToken;
        this.email = options.email;
        this.password = options.password;
        this.isGoogleLogin = options.isGoogleLogin;
        this.isMicrosoftLogin = options.isMicrosoftLogin;
		this.executablePath = options.executablePath;
		this.verbose = options.verbose;
		this.conversations = [];
		this.auth = null;
		this.expires = new Date();
        if(!this.sessionToken){
            this.pauseTokenChecks = true
        }else{
    		this.pauseTokenChecks = false
        }
		this.socket.on("connect", () => {
			console.log("Connected to server");
		});
		this.socket.on("disconnect", () => {
			console.log("Disconnected from server");
		});

        if (!this.sessionToken && !(this.email && this.password)) {
            throw new Error('Empty sessionToken and email/password, please recheck the configuration!')
        }     
        if(!(this.isMicrosoftLogin || this.isGoogleLogin || this.sessionToken) && !(process.env.CAPTCHA_TOKEN)){
            throw new Error('Missing CAPTCHA_TOKEN in .env file!')
        }
		setInterval(async () => {
			if (this.pauseTokenChecks) return;
			this.pauseTokenChecks = true;
			const now = new Date();
			const offset = 2 * 60 * 1000;
			if (this.expires < now - offset || !this.auth) {
				await this.getTokens();
			}
			this.pauseTokenChecks = false;
		}, 500);
		setInterval(() => {
			const now = Date.now();
			this.conversations = this.conversations.filter((conversation) => {
				return now - conversation.lastActive < 1800000; // 2 minutes in milliseconds
			});
		}, 60000);
	}

	addConversation(id) {
		let conversation = {
			id: id,
			conversationId: null,
			parentId: uuid.v4(),
			lastActive: Date.now(),
		};
		this.conversations.push(conversation);
		return conversation;
	}

	getConversationById(id) {
		let conversation = this.conversations.find(
			(conversation) => conversation.id === id,
		);
		if (!conversation) {
			conversation = this.addConversation(id);
		} else {
			conversation.lastActive = Date.now();
		}
		return conversation;
	}

	resetConversation(id = "default") {
		let conversation = this.conversations.find(
			(conversation) => conversation.id === id,
		);
		if (!conversation) return;
		conversation.conversationId = null;
	}

	async Wait(time) {
		return new Promise((resolve) => {
			setTimeout(resolve, time);
		});
	}

	async waitForReady() {
		while (!this.ready) await this.Wait(25);
		console.log("Ready");
	}

	async ask(prompt, id = "default", tryNum = 0) {
        if(tryNum >= 3){
            msg = {error :"Failed to reauthenticate session!"}
            return msg
        }
		if (!this.auth || !this.validateToken(this.auth)) await this.getTokens();
		let conversation = this.getConversationById(id);
		let data = await new Promise((resolve) => {
			this.socket.emit(
				"askQuestion",
				{
					prompt: prompt,
					parentId: conversation.parentId,
					conversationId: conversation.conversationId,
					auth: this.auth,
				},
				(data) => {
					resolve(data);
				},
			);
		});
        if(!data.messageId){
            console.log('Session expired!')
            await this.authenticate()
            tryNum++
            console.log(tryNum)
            data = await this.ask(prompt,id,tryNum)
        }
		if (data.error) console.log(`Error: ${data.error}`);

		conversation.parentId = data.messageId;
		conversation.conversationId = data.conversationId;
		return data;
	}

	validateToken(token) {
		if (!token) return false;
		const parsed = JSON.parse(
			Buffer.from(token.split(".")[1], "base64").toString(),
		);

		return Date.now() <= parsed.exp * 1000;
	}

	async getTokens() {
		await this.Wait(1000);
		let data = await new Promise((resolve) => {
			this.socket.emit("getSession", this.sessionToken, (data) => {
				resolve(data);
			});
		});
		if (data.error) console.log(`Error: ${data.error}`);
		this.sessionToken = data.sessionToken;
		this.auth = data.auth;
		this.expires = data.expires;
		this.ready = true;
	}

    async authenticate(){
        this.pauseTokenChecks = true;
        if (!this.email || !this.password){
            throw new Error('Could not fetch session token, no email/password in config!')
        }
        const authInfo = await getOpenAIAuth({
            email: this.email,
            password: this.password,
            isGoogleLogin: this.isGoogleLogin,
            isMicrosoftLogin: this.isMicrosoftLogin,
			executablePath: this.executablePath
        })
		if(this.verbose){
			console.log(`Session Token: ${authInfo.sessionToken}`)
		}
        this.sessionToken = authInfo.sessionToken
        this.pauseTokenChecks = false;
    }

    async init(){
        if(!this.sessionToken && this.email && this.password){
            await this.authenticate()
        }
        await this.waitForReady()
    }
}

module.exports = ChatGPT;
