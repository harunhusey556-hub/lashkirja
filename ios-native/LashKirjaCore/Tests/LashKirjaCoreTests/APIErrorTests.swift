import Testing
import Foundation
@testable import LashKirjaCore

@Test func decodesBothErrorEnvelopes() {
    let flat = APIErrorDecoder.decode(status: 400, data: Data(#"{"error":"Sähköposti puuttuu"}"#.utf8))
    #expect(flat.message == "Sähköposti puuttuu")
    #expect(flat.code == nil)
    let nested = APIErrorDecoder.decode(status: 422, data: Data(#"{"error":{"code":"VALIDATION","message":"Tarkista tiedot","details":[{"field":"email","message":"Virheellinen"}]}}"#.utf8))
    #expect(nested.code == "VALIDATION")
    #expect(nested.message == "Tarkista tiedot")
    #expect(nested.fields["email"] == "Virheellinen")
    let junk = APIErrorDecoder.decode(status: 502, data: Data("<html>".utf8))
    #expect(junk.message == "Palvelimeen ei saada yhteyttä. Yritä hetken päästä uudelleen.")
}
