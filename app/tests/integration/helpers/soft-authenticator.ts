import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator (ES256, "none" attestation) for the
 * integration suite. Produces the exact JSON shapes @simplewebauthn/browser
 * and the native iOS plugin hand to the server, signed with a real P-256
 * key, so the server's real verifier runs end to end.
 */
export class SoftAuthenticator {
  readonly credentialId = new Uint8Array(randomBytes(16));
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  /** The next counter value is counter + counterStep. 0/0 mimics Apple. */
  counter: number;
  counterStep: number;
  userHandle: string | null = null;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    options: { counter?: number; counterStep?: number } = {}
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
    this.counter = options.counter ?? 0;
    this.counterStep = options.counterStep ?? 0;
  }

  get id(): string {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  private cosePublicKey(): Uint8Array {
    const key = new Map<number, number | Uint8Array>();
    key.set(1, 2); // kty: EC2
    key.set(3, -7); // alg: ES256
    key.set(-1, 1); // crv: P-256
    key.set(-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url")));
    key.set(-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url")));
    return isoCBOR.encode(key);
  }

  private authData(flags: number, attested: boolean): Buffer {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter >>> 0);
    const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, Buffer.from(this.credentialId), Buffer.from(this.cosePublicKey()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() */
  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    // UP | UV | BE | BS | AT
    const authData = this.authData(0x01 | 0x04 | 0x08 | 0x10 | 0x40, true);
    const attestation = new Map<string, unknown>();
    attestation.set("fmt", "none");
    attestation.set("attStmt", new Map());
    attestation.set("authData", new Uint8Array(authData));
    const clientDataJSON = this.clientData("webauthn.create", options.challenge);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: Buffer.from(isoCBOR.encode(attestation as never)).toString("base64url"),
        transports: ["internal", "hybrid"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() */
  authenticate(options: { challenge: string }, overrides: { origin?: string; userHandle?: string | null } = {}) {
    this.counter += this.counterStep;
    const authData = this.authData(0x01 | 0x04 | 0x08 | 0x10, false);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, overrides.origin);
    const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
    const signature = sign("sha256", signed, this.privateKey); // DER, as WebAuthn ES256 expects
    const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle,
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }
}
