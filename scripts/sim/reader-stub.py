#!/usr/bin/env python3
"""Loopback stand-in for the cloud AI that reads receipts, for the simulator walk.

The demo API is pointed at it with LLM_BASE_URL=http://127.0.0.1:<port>/v1 and a dummy
LLM_API_KEY: every receipt reading (lib/ai.ts postExtraction) is answered with the same bill,
so a save files an ostolasku and the app's "Tallennettu · ostolasku luotu" toast can be tested
(OwnerScreensTests.testC). It cannot see the picture; the answer matches the app's fixture
(UITestHooks.fixtureReceipt) except that it calls it a "lasku". No date, as the fixture has
none: the reading is never complete, so the capture form still opens for the owner.
Any other model call (the assistant) gets a 503, as an unreachable provider would.
usage: reader-stub.py <port>
"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BILL = {
    "vendor": "Testikauppa Oy",
    "date": None,
    "totalAmount": 12.40,
    "vatDetails": [{"rate": 25.5, "amount": 2.52}],
    "category": None,
    "notes": None,
    "type": "meno",
    "reference": None,
    "invoiceNumber": None,
    "documentType": "lasku",
    "currency": "EUR",
    "sellerCountry": "FI",
    "originalAmount": None,
    "fxRate": None,
    "dueDate": None,
    "isCreditNote": False,
    "creditsInvoiceNumber": None,
}


def prompt_text(body):
    parts = []
    for message in body.get("messages", []):
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(item.get("text", "") for item in content if item.get("type") == "text")
    return "\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        # The extraction prompt asks for this JSON shape; the assistant's never does.
        if self.path.endswith("/chat/completions") and '"documentType"' in prompt_text(body):
            self.answer(200, {"choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(BILL)}}]})
        else:
            self.answer(503, {"error": {"message": "reader stub answers receipt readings only"}})

    def answer(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("reader-stub %s\n" % (fmt % args))


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
