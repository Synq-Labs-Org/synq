import Foundation
import SwiftUI

// Public initialisers for what the two hosts construct directly. Declared in
// extensions so the module keeps the implicit memberwise initialisers its own
// screens use; where the public one would have the memberwise signature it is
// declared in the type itself.

extension FundClient {
    public init(host: String) {
        self.host = host
    }
}

extension BusinessClient {
    public init(host: String) {
        self.host = host
    }
}
