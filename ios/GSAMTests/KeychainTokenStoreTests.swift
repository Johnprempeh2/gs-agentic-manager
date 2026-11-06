import Foundation
import Security
import Testing
@testable import GSAM

/// Runs against the simulator's real Keychain, under a service name of its own.
@Suite(.serialized) struct KeychainTokenStoreTests {
    let store = KeychainTokenStore(service: "com.greatstone.gsam.tests.\(UUID().uuidString)")

    @Test func savesReadsAndDeletesTheToken() throws {
        #expect(try store.read() == nil)

        try store.save("first-token")
        #expect(try store.read() == "first-token")

        try store.save("second-token")
        #expect(try store.read() == "second-token")

        try store.delete()
        #expect(try store.read() == nil)
    }

    @Test func deletingWhenEmptyIsFine() throws {
        try store.delete()
        #expect(try store.read() == nil)
    }

    @Test func theTokenStaysOnThisDevice() throws {
        try store.save("device-only-token")
        defer { try? store.delete() }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: store.account,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        let attributes = try #require(result as? [String: Any])
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }
}
