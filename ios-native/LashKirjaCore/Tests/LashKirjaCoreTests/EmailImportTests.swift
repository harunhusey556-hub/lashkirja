import Testing
import Foundation
@testable import LashKirjaCore

@Test func profileCarriesConnectedMailboxes() throws {
    let json = #"{"profile":{"email":"a@b.fi","entityType":"oy","vatRegistered":true,"imapAccounts":[{"id":"m1","email":"kuitit@gmail.com"}]}}"#
    let profile = try JSONDecoder().decode(ProfileResponse.self, from: Data(json.utf8)).profile
    #expect(profile.imapAccounts == [ImapAccount(id: "m1", email: "kuitit@gmail.com")])
}

@Test func profileWithoutMailboxesDecodes() throws {
    let json = #"{"profile":{"email":"a@b.fi","entityType":"oy","vatRegistered":false}}"#
    let profile = try JSONDecoder().decode(ProfileResponse.self, from: Data(json.utf8)).profile
    #expect(profile.imapAccounts == nil)
}

@Test func mailProvidersFillTheServer() {
    #expect(MailProvider.gmail.host == "imap.gmail.com")
    #expect(MailProvider.outlook.host == "outlook.office365.com")
    #expect(MailProvider.icloud.host == "imap.mail.me.com")
    #expect(MailProvider.other.host == nil)
    #expect(MailProvider.gmail.helpURL?.host == "myaccount.google.com")
}

@Test func connectRequestTrimsAndKeepsPortNumeric() throws {
    let request = try #require(ImapConnectRequest(email: "  kuitit@gmail.com ", password: "abcd efgh ijkl mnop", host: " imap.gmail.com ", port: "993"))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
    #expect(json["email"] as? String == "kuitit@gmail.com")
    #expect(json["host"] as? String == "imap.gmail.com")
    #expect(json["port"] as? Int == 993)
    // Google shows the app password in groups of four; the spaces are not part of it.
    #expect(json["password"] as? String == "abcdefghijklmnop")
}

@Test func connectRequestRefusesMissingFields() {
    #expect(ImapConnectRequest(email: "", password: "x", host: "imap.gmail.com", port: "993") == nil)
    #expect(ImapConnectRequest(email: "a@b.fi", password: "  ", host: "imap.gmail.com", port: "993") == nil)
    #expect(ImapConnectRequest(email: "a@b.fi", password: "x", host: "", port: "993") == nil)
    #expect(ImapConnectRequest(email: "a@b.fi", password: "x", host: "imap.x.fi", port: "abc") == nil)
    #expect(ImapConnectRequest(email: "a@b.fi", password: "x", host: "imap.x.fi", port: "70000") == nil)
}

@Test func syncResultDecodes() throws {
    let result = try JSONDecoder().decode(ImapSyncResult.self, from: Data(#"{"success":true,"count":3}"#.utf8))
    #expect(result.count == 3)
}
