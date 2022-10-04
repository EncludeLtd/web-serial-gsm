import { ATCommandSet, ATResponse, ATError, Sms } from './ATCommandSet';
const EventEmitter = require('events');

const defaultSerialConfig: SerialOptions = {
	baudRate: 57600
};

const defaultModemConfig = {
	timeout: 10000
};

const defaultModemOptions = {
	serialConfig: defaultSerialConfig,
	modemConfig: defaultModemConfig
};

type ModemOptions = typeof defaultModemOptions;

export type StatusChangeEvent = {
	name: 'statusChange';
	payload: {
		status: ModemStatus;
	};
};

export type ATEvent = {
	name: 'read' | 'write';
	payload: {
		command: string;
	};
};

type ModemStatus = 'connecting' | 'connected' | 'disconnected';

class Modem {
	port: SerialPort;
	scid: string | null = null;
	imei: string | null = null;
	phoneNumber = '';
	_status: ModemStatus = 'connecting';
	reader?: ReadableStreamDefaultReader<string>;
	readableStreamClosed?: Promise<void>;
	writer?: WritableStreamDefaultWriter<string>;
	writableStreamClosed?: Promise<void>;
	events = new EventEmitter();
	at = new ATCommandSet();
	modemOptions = defaultModemOptions;
	private reading = true;

	get status() {
		return this._status;
	}
	set status(val) {
		this._status = val;
		this.emit({ name: 'statusChange', payload: { status: this.status } });
	}

	constructor(
		port: SerialPort,
		modemOptions: Partial<ModemOptions> = defaultModemOptions
	) {
		this.port = port;
		this.modemOptions = { ...defaultModemOptions, ...modemOptions };
	}
	emit(event: StatusChangeEvent | ATEvent) {
		this.events.emit(event.name, event.payload);
	}
	addEventHandler<T extends StatusChangeEvent | ATEvent>(
		event: T['name'],
		cb: (payload: T['payload']) => void
	) {
		this.events.on(event, cb);
	}
	async connect() {
		try {
			await this.port.open(this.modemOptions.serialConfig);
			this.startReader();
			await this.startWriter();
			await this.boot();
			await this.setScid();
			await this.setImei();
		} catch (err) {
			console.error(err);
			this.status = 'disconnected';
		}
	}
	async reboot() {
		await this.boot();
		await this.setScid();
		await this.setImei();
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
		this.checkBootError(await this.checkOk());
		this.checkBootError(await this.setPdu(0));
		this.checkBootError(await this.setErrorFormat(1));
		this.checkBootError(await this.setEcho(0));
		this.checkBootError(await this.setPreferredStorage());
	}
	checkBootError(arg: [ATResponse | null, ATError | null]): void {
		if (arg[1]) {
			this.status = 'disconnected';
			throw new Error(`Failed to boot: ${arg[1].response}`);
		}
	}

	async setScid(): Promise<void> {
		await this.sendCommand(this.at.getSimId());
		const [res] = await this.listenUntilEnd();
		this.scid = res?.items?.[0]?.data || null;
	}
	async setImei(): Promise<void> {
		await this.sendCommand(this.at.getIMEI());
		const [res] = await this.listenUntilEnd();
		this.imei = res?.items?.[0]?.data || null;
	}
	async setErrorFormat(mode: 0 | 1 | 2) {
		await this.sendCommand(this.at.setErrorFormat(mode));
		return await this.listenUntilEnd();
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
		if (err) throw new Error(err.response);
		const messages = Sms.fromATResponse(res!);
		return messages;
	}
	async deleteSms(index: number) {
		await this.sendCommand(this.at.deleteSms(index));
		return await this.listenUntilEnd();
	}
	async sendSms(
		phoneNumber: string,
		text: string,
		options?: { encoding?: 'gsm' | 'ucs2' }
	): Promise<[ATResponse[] | null, ATError | null]> {
		let pduList: ReturnType<typeof Sms.generatePdu>;
		if (options?.encoding) {
			pduList = Sms.generatePdu(phoneNumber, text, options);
		} else if (text.includes('@')) {
			pduList = Sms.generatePdu(phoneNumber, text, { encoding: 'ucs2' });
		} else {
			try {
				pduList = Sms.generatePdu(phoneNumber, text);
			} catch (err: any) {
				if (options?.encoding === 'ucs2') throw new Error(err.message);
				pduList = Sms.generatePdu(phoneNumber, text, { encoding: 'ucs2' });
			}
		}
		const responses: ATResponse[] = [];
		for (let pdu of pduList) {
			const { length, hex } = pdu;
			await this.sendCommand(this.at.setSmsLength(length));
			const [, lengthErr] = await this.listenUntilEnd(this.at.INP);
			if (lengthErr) return [null, lengthErr];

			await this.sendCommand(this.at.sendSms(hex));
			const [res, err] = await this.listenUntilEnd(this.at.OK);
			if (err) return [responses, err];

			if (res) responses.push(res);
		}
		return [responses, null];
	}
	listenUntilEnd(
		end: string = this.at.OK,
		timeout = this.modemOptions.modemConfig.timeout
	): Promise<[ATResponse | null, ATError | null]> {
		let res = '';
		return new Promise((resolve) => {
			const listener = (buffer: string) => {
				res += buffer;
				if (res.endsWith(end)) {
					this.events.removeListener('modemResponse', listener);
					this.emit({ name: 'read', payload: { command: res } });
					return resolve([this.at.response(res), null]);
				}
				if (res.includes(this.at.ERR)) {
					this.events.removeListener('modemResponse', listener);
					return resolve([null, this.at.error(res)]);
				}
			};
			this.events.on('modemResponse', listener);
			setTimeout(() => {
				this.events.removeListener('modemResponse', listener);
				return resolve([null, this.at.error('ERROR: Request Timed Out')]);
			}, timeout);
		});
	}
	async sendCommand(command: string) {
		if (!this.port || !this.port.writable || !this.writer)
			throw new Error(
				'Modem port is not set or not connected; cannot send command.'
			);
		this.emit({ name: 'write', payload: { command } });
		await this.writer.write(command);
	}
	async disconnect() {
		this.reading = false;
		this.reader?.cancel();
		await this.readableStreamClosed?.catch(() => {
			/* Ignore the error */
		});
		this.writer?.close();
		await this.writableStreamClosed;
		await this.port.close();
		this.status = 'disconnected';
	}
	async sendUserInputCommand(command: string): Promise<ATResponse> {
		if (!this.port || !this.port.writable || !this.writer)
			throw new Error(
				'Modem port is not set or not connected; cannot send command.'
			);
		command = command.replace('<crlf>', '\r\n').replace('<ctrl-z>', '\x1A');
		this.emit({ name: 'write', payload: { command } });
		await this.writer.write(command);
		const [res, err] = await this.listenUntilEnd();
		if (err) throw new Error(err.response);
		return res!;
	}
	get portInfo() {
		return this.port.getInfo();
	}
}

export default Modem;
