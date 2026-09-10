import { sendCmd } from "./cdp.mjs";

function matches(url, filters) {
	return filters.length === 0 || filters.some((filter) => url.includes(filter));
}

export function createNetworkObserver(ws, {
	filters = [],
	withBody = false,
	withResponse = false,
	onEvent,
} = {}) {
	const requests = new Map();
	const responses = new Map();
	const emitted = new Set();
	const events = [];

	function publish(event) {
		events.push(event);
		if (onEvent) onEvent(event);
	}

	async function emitResponse(requestId) {
		if (emitted.has(requestId)) return;
		const request = requests.get(requestId);
		const response = responses.get(requestId);
		if (!request || !response || !matches(request.url, filters)) return;
		emitted.add(requestId);

		const event = {
			type: "network",
			ts: Date.now(),
			method: request.method,
			url: request.url,
			status: response.status,
			mimeType: response.mimeType,
			requestBody: withBody ? request.postData : undefined,
		};

		if (withResponse) {
			try {
				const body = await sendCmd(ws, "Network.getResponseBody", { requestId });
				event.responseBody = body.base64Encoded ? "[base64]" : body.body;
			} catch (error) {
				event.responseError = error.message;
			}
		}

		publish(event);
	}

	function onMessage({ data }) {
		let msg;
		try { msg = JSON.parse(data); } catch { return; }

		if (msg.method === "Network.requestWillBeSent") {
			const req = msg.params.request;
			requests.set(msg.params.requestId, {
				method: req.method,
				url: req.url,
				postData: req.postData,
			});
		}

		if (msg.method === "Network.responseReceived") {
			const res = msg.params.response;
			responses.set(msg.params.requestId, {
				status: res.status,
				mimeType: res.mimeType,
			});
			if (!withResponse) void emitResponse(msg.params.requestId);
		}

		if (msg.method === "Network.loadingFinished" && withResponse) {
			void emitResponse(msg.params.requestId);
		}
	}

	ws.addEventListener("message", onMessage);

	return {
		events,
		enable: () => sendCmd(ws, "Network.enable"),
		dispose: () => ws.removeEventListener("message", onMessage),
	};
}
