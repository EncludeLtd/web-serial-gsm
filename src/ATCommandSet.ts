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
	response: string;
	constructor(res: string, at: ATCommandSet) {
		this.response = res.trim();
	}
}

export class ATResponse {
	output: string;
	ok: boolean;
	items: ATResponseItem[] = [];
	constructor(output: string, at: ATCommandSet) {
		// Save initial output
		this.output = output;

		// Check if output ends with OK and remove from output
		this.ok = output.endsWith(at.OK);
		output = output.slice(0, -at.OK.length);

		const itemArray = output.trim().split(at.CR);
		while (itemArray.length) {
			const cmd = itemArray.shift();
			const data = itemArray.shift();
			this.items.push(new ATResponseItem(cmd!, data!));
		}
		console.log(this);
	}
}

export class ATResponseItem {
	command: string;
	args: (number | null)[];
	data: string;
	private _pdu!: ParsedPdu;
	constructor(command: string, data: string) {
		const [cmd, args] = command.split(': ');
		this.command = cmd;
		this.args = args?.split(',').map((arg) => (arg ? parseInt(arg) : null));
		this.data = data;
	}
	get pdu() {
		if (!this._pdu) this._pdu = smsPdu.parse(this.data);
		return this._pdu;
	}
}
export class Sms {
	segments: ATResponseItem[];
	length: number;
	origin: string;
	sender: string;
	text: string;
	timestamp: Date;
	type: string;

	constructor(segments: ATResponseItem[]) {
		this.segments = segments;
		this.length = segments.reduce(
			(acc, curr) => (curr.args[3] ? acc + curr.args[3] : acc),
			0
		);
		this.origin = segments[0].pdu.origination;
		this.sender = segments[0].pdu.smsc;
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
	static generatePdu(phoneNumber: string, text: string): Pdu[] {
		return smsPdu.generateSubmit(phoneNumber, text);
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
		return `AT^SCID`;
	}
	getIMEI() {
		return `AT+GSN`;
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
