import Testing
import Foundation
@testable import LashKirjaCore

@Test func apiDates() {
    let d = APIDate.day("2026-10-02")!
    #expect(APIDate.dayString(d) == "2026-10-02")
    #expect(APIDate.month(d) == "2026-10")
    #expect(APIDate.displayDay("2026-10-02") == "2.10.2026")
    #expect(APIDate.day("2026-13-40") == nil)
    #expect(APIDate.displayDay("nonsense") == "nonsense")
}

@Test func timestampsShowHelsinkiTime() {
    #expect(APIDate.timestamp("2026-10-02T09:05:00.000Z") == "2.10.2026 klo 12.05")
    #expect(APIDate.timestamp("2026-01-15T22:30:00Z") == "16.1.2026 klo 0.30")
    #expect(APIDate.timestamp("eilen") == "eilen")
}

// A receipt date is a calendar day. The CI simulator runs in UTC: at 22.30 UTC (01.30 in Helsinki)
// the capture form's picker showed 12.10.2026 for a saved "2026-10-13", listed as 13.10.2026.
private let helsinki = TimeZone(identifier: "Europe/Helsinki")!
private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!
private let utc = TimeZone(identifier: "UTC")!

private func shownDay(_ date: Date, in zone: TimeZone) -> Int {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar.component(.day, from: date)
}

@Test(arguments: [helsinki, losAngeles, utc])
func pickerShowsTheSavedDayInAnyDeviceZone(zone: TimeZone) throws {
    let picked = try #require(APIDate.pickerDate("2026-10-13", in: zone))
    #expect(shownDay(picked, in: zone) == 13)
    #expect(APIDate.pickerDay(picked, in: zone) == "2026-10-13")
    #expect(APIDate.pickerDate("2026-02-30", in: zone) == nil)
}

@Test func helsinkiMidnightIsTheDayBeforeWestOfHelsinki() throws {
    // Why the picker cannot take `APIDate.day`: Helsinki midnight is still 12.10 in UTC and LA.
    let midnight = try #require(APIDate.day("2026-10-13"))
    #expect(shownDay(midnight, in: utc) == 12)
    #expect(shownDay(midnight, in: losAngeles) == 12)
}

@Test(arguments: [helsinki, losAngeles, utc])
func pickerRoundTripsEveryDayAcrossTheYear(zone: TimeZone) throws {
    // Covers both DST changes in Helsinki and Los Angeles and the month and year ends.
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    var day = try #require(calendar.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 12)))
    for _ in 0..<366 {
        let text = APIDate.pickerDay(day, in: zone)
        let back = try #require(APIDate.pickerDate(text, in: zone))
        #expect(APIDate.pickerDay(back, in: zone) == text)
        day = try #require(calendar.date(byAdding: .day, value: 1, to: day))
    }
}

@Test func pickerDayKeepsTheDeviceDayAroundMidnight() throws {
    let iso = ISO8601DateFormatter()
    // 23.30 and 00.30 in each zone: the picked day is the device's, never shifted by Helsinki.
    let laLate = try #require(iso.date(from: "2026-10-13T06:30:00Z")) // 23.30 12.10 in LA
    let laEarly = try #require(iso.date(from: "2026-10-13T07:30:00Z")) // 00.30 13.10 in LA
    #expect(APIDate.pickerDay(laLate, in: losAngeles) == "2026-10-12")
    #expect(APIDate.pickerDay(laEarly, in: losAngeles) == "2026-10-13")
    let hkiLate = try #require(iso.date(from: "2026-10-31T21:30:00Z")) // 23.30 31.10 in Helsinki
    let hkiEarly = try #require(iso.date(from: "2026-10-31T22:30:00Z")) // 00.30 1.11 in Helsinki
    #expect(APIDate.pickerDay(hkiLate, in: helsinki) == "2026-10-31")
    #expect(APIDate.pickerDay(hkiEarly, in: helsinki) == "2026-11-01")
}

@Test func newCaptureDefaultsToTheHelsinkiDayAndThePickerShowsIt() throws {
    // The form's "today" is the Helsinki day (as on the web); a UTC device must show that day too.
    let runnerClock = try #require(ISO8601DateFormatter().date(from: "2026-10-12T22:30:00Z"))
    let today = APIDate.dayString(runnerClock)
    #expect(today == "2026-10-13")
    for zone in [helsinki, losAngeles, utc] {
        let shown = try #require(APIDate.pickerDate(today, in: zone))
        #expect(shownDay(shown, in: zone) == 13)
        #expect(APIDate.pickerDay(shown, in: zone) == today)
    }
    #expect(APIDate.displayDay("2026-10-13T00:00:00.000Z") == "13.10.2026")
}
