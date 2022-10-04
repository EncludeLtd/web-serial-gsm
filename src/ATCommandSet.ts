const smsPdu = require('node-sms-pdu');

interface Pdu {
	hex: string;
	length: number;
	encoding: string;
	buffer: Uint8Array;
}

interface ParsedPdu {
	concat?: {
		parts: String[];
		reference: number;
		sequence: number;
		total: number;
	};
	origination: string;
	smsc: string;
	text: string;
	timestamp: string;
	type: string;
}

export class ATError {
	type: '+CMS' | '+CME';
	response: string;
	code: string;
	constructor(res: string, at: ATCommandSet) {
		this.response = res.trim();
		const segments = res.split(' ');
		this.type = segments.shift()?.trim() as '+CMS' | '+CME';
		this.code = segments.pop()!?.trim();
	}
}

export class ATResponse {
	rawOutput: string;
	ok: boolean;
	items: ATResponseItem[] = [];
	constructor(rawOutput: string, at: ATCommandSet) {
		// Save initial rawOutput
		this.rawOutput = rawOutput;

		// Check if output ends with OK and remove from output
		this.ok = rawOutput.endsWith(at.OK);
		rawOutput = rawOutput.slice(0, -at.OK.length);

		const splitOutput = rawOutput.split(/(?=\r\n[\+\^])/g).filter((s) => s);
		this.items = splitOutput.map((item) => new ATResponseItem(item));
	}
}

export class ATResponseItem {
	rawOutput: string;
	command?: string;
	args: string[] = [];
	data?: string;
	private _pdu!: ParsedPdu;
	constructor(item: string) {
		this.rawOutput = item.trim();
		const splitOutput = this.rawOutput
			.split(/(?<=(?:\r\n|: ))/g)
			.map((s) => s.trim())
			.filter((s) => s);
		this.data = splitOutput.pop();
		const command = splitOutput.shift();
		if (command) this.command = command;
		const args = splitOutput.pop();
		if (args) this.args = args.split(',');
	}
	get pdu() {
		if (!this._pdu) this._pdu = smsPdu.parse(this.data);
		return this._pdu;
	}
}
export class Sms {
	segments: ATResponseItem[];
	length: number;
	sender: string;
	text: string;
	timestamp: Date;
	type: string;
	get indices(): (number | null)[] {
		return this.segments.map((item) => parseInt(item.args[0]) || null);
	}

	constructor(segments: ATResponseItem[]) {
		this.segments = segments;
		this.length = 0; //TODO: Count length of SMS
		this.sender = segments[0].pdu.origination;
		this.text = segments
			.sort((prev, curr) =>
				prev.pdu.concat && curr.pdu.concat
					? prev.pdu.concat.sequence - curr.pdu.concat.sequence
					: 0
			)
			.reduce((acc, curr) => (acc += curr.pdu.text), '');
		this.timestamp = new Date(segments[0].pdu.timestamp);
		this.type = segments[0].pdu.type;
	}
	static fromATResponse(res: ATResponse): Sms[] {
		const messages: Sms[] = [];
		const concatenated = new Map<number, ATResponseItem[]>();
		res.items.forEach((item) => {
			if (!item.pdu.concat) return messages.push(new Sms([item]));

			const existingKey = concatenated.get(item.pdu.concat.reference);
			if (existingKey) return existingKey.push(item);

			concatenated.set(item.pdu.concat.reference, [item]);
		});
		concatenated.forEach((item) => messages.push(new Sms(item)));
		return messages;
	}
	static generatePdu(
		phoneNumber: string,
		text: string,
		options?: { encoding?: 'gsm' | 'ucs2' }
	): Pdu[] {
		return smsPdu.generateSubmit(phoneNumber, text, options);
	}
}

export class ATCommandSet {
	CR = '\r\n';
	OK = `${this.CR}OK${this.CR}`;
	INP = '> ';
	CTRL_Z = '\x1A';
	ERR = 'ERROR';
	constructor() {}

	AT() {
		return `AT${this.CR}`;
	}
	getSimId() {
		return `AT^SCID${this.CR}`;
	}
	getIMEI() {
		return `AT+GSN${this.CR}`;
	}
	setErrorFormat(mode: 0 | 1 | 2) {
		return `AT+CMEE=${mode}${this.CR}`;
	}
	listMessages(status: 1 | 2 | 3 | 4 | string) {
		return `AT+CMGL=${status}${this.CR}`;
	}
	setPdu(mode: 0 | 1) {
		return `AT+CMGF=${mode}${this.CR}`;
	}
	setEcho(mode: 0 | 1) {
		return `ATE${mode}${this.CR}`;
	}
	deleteSms(index: number) {
		return `AT+CMGD=${index}${this.CR}`;
	}
	setPreferredStorage(storage: 'SM' | 'ME' | 'MT' | 'MB' | 'ST' | 'TA') {
		return `AT+CPMS=${storage},${storage}${this.CR}`;
	}
	setSmsLength(length: number) {
		return `AT+CMGS=${length}${this.CR}`;
	}
	sendSms(hex: string) {
		return `${hex}${this.CTRL_Z}`;
	}
	response(res: string): ATResponse {
		return new ATResponse(res, this);
	}
	error(res: string): ATError {
		return new ATError(res, this);
	}
}
