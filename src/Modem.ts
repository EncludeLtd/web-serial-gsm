import { ATCommandSet, ATResponse, ATError, Sms } from './ATCommandSet';
const EventEmitter = require('events');

class Modem {
	port: SerialPort;
	phoneNumber: string;
	reader?: ReadableStreamDefaultReader<string>;
	readableStreamClosed?: Promise<void>;
	writer?: WritableStreamDefaultWriter<string>;
	writableStreamClosed?: Promise<void>;
	events = new EventEmitter();
	at = new ATCommandSet();
	private reading = true;

	constructor(port: SerialPort, phoneNumber: string) {
		this.port = port;
		this.phoneNumber = phoneNumber;
		this.port.addEventListener('disconnect', () => this.disconnect());
		this.port.addEventListener('connect', () => this.connect());
	}
	async connect() {
		this.startReader();
		this.startWriter();
		await this.boot();
	}
	async startWriter() {
		if (!this.port || !this.port.writable)
			throw new Error('Modem port is not set; cannot start writer.');
		const textEncoder = new TextEncoderStream();
		this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
		this.writer = textEncoder.writable.getWriter();
	}
	async startReader() {
		if (!this.port || !this.port.readable)
			throw new Error('Modem port is not set; cannot start reader.');
		this.reading = true;
		const textDecoder = new TextDecoderStream();
		this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
		this.reader = textDecoder.readable.getReader();
		while (this.reading) {
			const { value, done } = await this.reader.read();
			if (done) this.reader.releaseLock();
			this.events.emit('modemResponse', value);
		}
	}
	async boot() {
		const [pduRes, pduErr] = await this.setPdu(0);
		const [echoRes, echoErr] = await this.setEcho(0);
		const [psRes, psErr] = await this.setPreferredStorage();
		const [okRes, okErr] = await this.checkOk();
	}
	async setPreferredStorage() {
		await this.sendCommand(this.at.setPreferredStorage('ME'));
		return await this.listenUntilEnd();
	}
	async checkOk() {
		await this.sendCommand(this.at.AT());
		return await this.listenUntilEnd();
	}
	async setPdu(mode: 0 | 1) {
		await this.sendCommand(this.at.setPdu(mode));
		return await this.listenUntilEnd();
	}
	async setEcho(mode: 0 | 1) {
		await this.sendCommand(this.at.setEcho(mode));
		return await this.listenUntilEnd();
	}
	async listMessages() {
		await this.sendCommand(this.at.listMessages(4));
		const [res, err] = await this.listenUntilEnd();
		if (!res) return [null, err];
		const messages = Sms.fromATResponse(res);
		return messages;
	}
	async deleteSms(index: number) {
		await this.sendCommand(this.at.deleteSms(index));
		const res = await this.listenUntilEnd();
	}
	async sendSms(phoneNumber: string, text: string) {
		const pduList = Sms.generatePdu(phoneNumber, text);
		console.log('===============')
		console.log(pduList)
		for (let pdu of pduList) {
			const { length, hex } = pdu;
			await this.sendCommand(this.at.setSmsLength(length));

			const [lengthRes, lengthErr] = await this.listenUntilEnd(this.at.INP);
			if (lengthErr) return [null, lengthErr];

			await this.sendCommand(this.at.sendSms(hex));
			return await this.listenUntilEnd(this.at.OK);
		}
	}
	listenUntilEnd(
		end: string = this.at.OK,
		timeout = 5000
	): Promise<[ATResponse | null, ATError | null]> {
		let res = '';
		return new Promise((resolve) => {
			const listener = (buffer: string) => {
				res += buffer;
				if (res.endsWith(end)) {
					this.events.removeListener('modemResponse', listener);
					resolve([this.at.response(res), null]);
				}
				if (res.includes(this.at.ERR)) {
					this.events.removeListener('modemResponse', listener);
					resolve([null, this.at.error(res)]);
				}
				setTimeout(() => {
					this.events.removeListener('modemResponse', listener);
					resolve([null, this.at.error('ERROR: Request Timed Out')]);
				}, timeout);
			};
			this.events.on('modemResponse', listener);
		});
	}
	async sendCommand(command: string) {
		if (!this.port || !this.port.writable || !this.writer)
			throw new Error(
				'Modem port is not set or not connected; cannot send command.'
			);
		await this.writer.write(command);
	}
	async disconnect() {
		console.log('Disconnecting...');
		this.reading = false;
		this.reader?.cancel();
		await this.readableStreamClosed?.catch(() => {
			/* Ignore the error */
		});
		this.writer?.close();
		await this.writableStreamClosed;
		await this.port.close();
	}
	async sendUserInputCommand(command: string) {
		if (!this.port || !this.port.writable || !this.writer)
			throw new Error(
				'Modem port is not set or not connected; cannot send command.'
			);
		command = command.replace('<crlf>', '\r\n').replace('<ctrl-Z', '\x1A');
		await this.writer.write(command);
		const [res, err] = await this.listenUntilEnd();
		if (res) console.log(res);
		if (err) console.error(err);
	}
	get portInfo() {
		return this.port.getInfo();
	}
}

export default Modem;
