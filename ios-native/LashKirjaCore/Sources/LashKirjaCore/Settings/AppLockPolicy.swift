import Foundation

/// The app lock's rules (the PIN itself is hashed and stored by the app).
public enum AppLockPolicy {
    /// 4 to 8 digits.
    public static func acceptable(_ pin: String) -> Bool {
        (4...8).contains(pin.count) && pin.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// Seconds to wait after `failures` wrong PINs: 1, 2, 4, 8, 16, then 30.
    public static func delay(afterFailures failures: Int) -> Int {
        guard failures > 0 else { return 0 }
        if failures > 5 { return 30 }
        return 1 << (failures - 1)
    }
}
