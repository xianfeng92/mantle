import XCTest
@testable import Mantle

final class ReturnsTypesTests: XCTestCase {

    func testDecodeDailyDigestEntry() throws {
        let json = """
        {
          "id": "abc-123",
          "kind": "twitter-digest.daily",
          "title": "今日精选 3 条",
          "summary": "覆盖 agent / rag / 端侧推理",
          "payload": {
            "mode": "daily",
            "output": {
              "topPicks": ["1", "2", "3"],
              "rationale": "r"
            }
          },
          "tags": ["twitter-digest", "daily", "2026-04-16"],
          "createdAt": "2026-04-16T08:00:00.000Z",
          "source": { "taskId": "twitter-digest.daily" }
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(ReturnEntry.self, from: json)
        XCTAssertEqual(entry.id, "abc-123")
        XCTAssertEqual(entry.kind, "twitter-digest.daily")
        XCTAssertFalse(entry.isAcked)
        XCTAssertEqual(entry.tags.count, 3)
        XCTAssertNotNil(entry.createdAtDate)
    }

    func testDecodeAckedEntry() throws {
        let json = """
        {
          "id": "acked-1",
          "kind": "test",
          "title": "t",
          "payload": null,
          "tags": [],
          "createdAt": "2026-04-16T08:00:00.000Z",
          "source": {},
          "ackedAt": "2026-04-16T09:00:00.000Z"
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(ReturnEntry.self, from: json)
        XCTAssertTrue(entry.isAcked)
        XCTAssertNotNil(entry.ackedAtDate)
    }

    func testDecodeListEnvelope() throws {
        let json = """
        {
          "entries": [
            {
              "id": "e1",
              "kind": "k",
              "title": "t1",
              "payload": "hello",
              "tags": [],
              "createdAt": "2026-04-16T08:00:00.000Z",
              "source": {}
            }
          ],
          "count": 1
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(ReturnsListResponse.self, from: json)
        XCTAssertEqual(response.count, 1)
        XCTAssertEqual(response.entries.first?.id, "e1")
    }

    func testJSONValueDecodesMixedPayload() throws {
        let json = """
        { "payload": { "a": 1, "b": "x", "c": [true, null], "d": { "nested": 3.14 } } }
        """.data(using: .utf8)!

        struct Wrapper: Decodable {
            let payload: JSONValue
        }
        let wrapper = try JSONDecoder().decode(Wrapper.self, from: json)
        guard case .object(let obj) = wrapper.payload else {
            XCTFail("Expected object payload")
            return
        }
        XCTAssertEqual(obj.count, 4)
    }
}
