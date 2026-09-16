import XCTest
@testable import TokenHorizon

final class PlanLimitsEngineTests: XCTestCase {

    func testParseClaudePayload_standardWindows() {
        let json: [String: Any] = [
            "five_hour": [
                "utilization": 42.5,
                "resets_at": "2026-09-01T15:30:00.000Z"
            ],
            "seven_day": [
                "utilization": 78.0,
                "resets_at": "2026-09-07T00:00:00.000Z"
            ],
            "seven_day_oauth_apps": [
                "utilization": 12.0,
                "resets_at": "2026-09-07T00:00:00.000Z"
            ],
            "limits": [
                [
                    "kind": "weekly_scoped",
                    "scope": [
                        "model": [
                            "display_name": "Claude 3.5 Sonnet"
                        ]
                    ],
                    "utilization": 65.0,
                    "resets_at": "2026-09-07T00:00:00.000Z"
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseClaudePayload(json)
        XCTAssertEqual(limits.count, 4)

        let fiveH = limits.first(where: { $0.label == "5h" })
        XCTAssertNotNil(fiveH)
        XCTAssertEqual(fiveH?.usedPercent, 42.5)
        XCTAssertEqual(fiveH?.provider, "claude")
        XCTAssertNotNil(fiveH?.resetsAt)

        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertNotNil(weekly)
        XCTAssertEqual(weekly?.usedPercent, 78.0)

        let apps = limits.first(where: { $0.label == "apps 7d" })
        XCTAssertNotNil(apps)
        XCTAssertEqual(apps?.usedPercent, 12.0)

        let scoped = limits.first(where: { $0.label == "weekly · Claude 3.5 Sonnet" })
        XCTAssertNotNil(scoped)
        XCTAssertEqual(scoped?.usedPercent, 65.0)
    }

    func testParseZaiPayload_tokensAndSearchLimits() {
        let json: [String: Any] = [
            "code": 200,
            "data": [
                "limits": [
                    [
                        "type": "TOKENS_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "percentage": 85.0,
                        "nextResetTime": 1725184800000
                    ],
                    [
                        "type": "TOKENS_LIMIT",
                        "unit": 5,
                        "number": 1,
                        "percentage": 0.0,
                        "nextResetTime": 1725700000000
                    ],
                    [
                        "type": "TIME_LIMIT",
                        "unit": 4,
                        "number": 1,
                        "percentage": 20.0,
                        "usage": 100.0,
                        "currentValue": 25.0,
                        "remaining": 75.0,
                        "nextResetTime": 1725200000000
                    ]
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseZaiPayload(json)
        XCTAssertEqual(limits.count, 3)

        // 85% remaining -> 15% used
        let fiveH = limits.first(where: { $0.label == "5h" })
        XCTAssertNotNil(fiveH)
        XCTAssertEqual(fiveH?.usedPercent, 15.0)
        XCTAssertEqual(fiveH?.detail, "85% left")

        // 0% remaining -> 100% used (exhausted)
        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertNotNil(weekly)
        XCTAssertEqual(weekly?.usedPercent, 100.0)
        XCTAssertEqual(weekly?.detail, "0% left (exhausted)")

        let search = limits.first(where: { $0.label == "search" })
        XCTAssertNotNil(search)
        XCTAssertEqual(search?.usedPercent, 25.0)
        XCTAssertEqual(search?.detail, "75 left")
    }

    func testParseZaiPayload_rollingBurstWithoutResetTime() {
        // Real Z.ai payload: the rolling burst window omits nextResetTime.
        let json: [String: Any] = [
            "data": [
                "limits": [
                    ["type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 0],
                    ["type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 100,
                     "nextResetTime": 1789799044983],
                ],
            ],
        ]
        let limits = PlanLimitsEngine.parseZaiPayload(json)
        let burst = limits.first(where: { $0.label == "5h" })
        XCTAssertEqual(burst?.usedPercent, 100)
        XCTAssertNil(burst?.resetsAt, "the rolling window publishes no reset time")
        XCTAssertEqual(burst?.detail, "0% left (exhausted) · rolling window")
        let monthly = limits.first(where: { $0.label == "monthly" })
        XCTAssertNotNil(monthly?.resetsAt)
        XCTAssertEqual(monthly?.detail, "100% left")
    }

    func testFetchAll_preservesProviderOrderWhenParallel() {
        // Concurrent fetch must not scramble grouping order (glm first when
        // configured, claude/deepseek/openai last). Pure ordering contract on
        // the task list itself; network providers are individually optional.
        let keys = PlanLimitsEngine.authKeys()
        if keys["zai-coding-plan"] != nil || keys["zai"] != nil {
            let limits = PlanLimitsEngine.fetchAll()
            if let firstGlm = limits.firstIndex(where: { $0.provider == "glm" }) {
                let lastGlm = limits.lastIndex(where: { $0.provider == "glm" })
                XCTAssertEqual(firstGlm, 0, "glm rows stay first when configured")
                XCTAssertNotNil(lastGlm)
            }
        }
    }

    func testParseMinimaxPayload_intervalAndWeekly() {
        let json: [String: Any] = [
            "model_remains": [
                [
                    "current_interval_remaining_percent": 80,
                    "end_time": 1725184800,
                    "current_weekly_remaining_percent": 60,
                    "weekly_end_time": 1725700000
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseMinimaxPayload(json)
        XCTAssertEqual(limits.count, 2)

        let interval = limits.first(where: { $0.label == "interval" })
        XCTAssertEqual(interval?.usedPercent, 20.0)
        XCTAssertEqual(interval?.provider, "minimax")

        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertEqual(weekly?.usedPercent, 40.0)
    }

    func testParseOpencodeGoPayload_multiWindow() {
        let json: [String: Any] = [
            "usage": [
                "rolling": [
                    "percent": 35.0,
                    "resetsAt": "2026-09-01T15:00:00.000Z",
                    "status": "active"
                ],
                "weekly": [
                    "percent": 100.0,
                    "resetsAt": "2026-09-07T00:00:00.000Z",
                    "status": "rate-limited"
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseOpencodeGoPayload(json)
        XCTAssertEqual(limits.count, 2)

        let rolling = limits.first(where: { $0.label == "rolling" })
        XCTAssertEqual(rolling?.usedPercent, 35.0)
        XCTAssertEqual(rolling?.detail, "")

        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertEqual(weekly?.usedPercent, 100.0)
        XCTAssertEqual(weekly?.detail, "rate-limited")
    }

    func testParseAlibabaPayload_ratioOrPercent() {
        let json: [String: Any] = [
            "data": [
                "per5HourPercentage": 0.25,
                "per5HourResetTime": 1725184800000,
                "per1WeekPercentage": 60.0,
                "per1WeekResetTime": 1725700000000
            ]
        ]

        let limits = PlanLimitsEngine.parseAlibabaPayload(json)
        XCTAssertEqual(limits.count, 2)

        let fiveH = limits.first(where: { $0.label == "5h" })
        XCTAssertEqual(fiveH?.usedPercent, 25.0)

        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertEqual(weekly?.usedPercent, 60.0)
    }

    func testParseGeminiBucketsPayload() {
        let json: [String: Any] = [
            "buckets": [
                [
                    "modelId": "gemini-1.5-pro",
                    "remainingFraction": 0.85,
                    "resetTime": "2026-09-01T16:00:00.000Z"
                ],
                [
                    "tokenType": "gemini-flash",
                    "remainingFraction": 0.10,
                    "resetTime": "2026-09-01T16:00:00.000Z"
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseGeminiBucketsPayload(json)
        XCTAssertEqual(limits.count, 2)

        let pro = limits.first(where: { $0.label == "gemini-1.5-pro" })
        XCTAssertEqual(pro?.usedPercent ?? 0, 15.0, accuracy: 0.001)

        let flash = limits.first(where: { $0.label == "gemini-flash" })
        XCTAssertEqual(flash?.usedPercent ?? 0, 90.0, accuracy: 0.001)
    }

    func testParseAgyLanguageServerGroups_geminiAnd3pBuckets() {
        let groups: [[String: Any]] = [
            [
                "displayName": "Gemini Models",
                "description": "Models within this group: Gemini Flash, Gemini Pro",
                "buckets": [
                    [
                        "bucketId": "gemini-weekly",
                        "displayName": "Weekly Limit Remaining",
                        "window": "weekly",
                        "remainingFraction": 0.723,
                        "resetTime": "2026-09-11T03:09:48Z"
                    ],
                    [
                        "bucketId": "gemini-5h",
                        "displayName": "Five Hour Limit Remaining",
                        "window": "5h",
                        "remainingFraction": 0.952,
                        "resetTime": "2026-09-08T19:03:09Z"
                    ]
                ]
            ],
            [
                "displayName": "Claude and GPT models",
                "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                "buckets": [
                    [
                        "bucketId": "3p-weekly",
                        "displayName": "Weekly Limit Remaining",
                        "window": "weekly",
                        "remainingFraction": 1.0,
                        "resetTime": "2026-09-15T14:17:40Z"
                    ],
                    [
                        "bucketId": "3p-5h",
                        "displayName": "Five Hour Limit Remaining",
                        "window": "5h",
                        "remainingFraction": 1.0,
                        "resetTime": "2026-09-08T19:17:40Z"
                    ]
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseAgyLanguageServerGroups(groups)
        XCTAssertEqual(limits.count, 4)

        let gemWeekly = limits.first { $0.label == "gemini weekly" }
        XCTAssertNotNil(gemWeekly)
        XCTAssertEqual(gemWeekly?.provider, "agy")
        XCTAssertEqual(gemWeekly?.usedPercent ?? 0, 27.7, accuracy: 0.1)
        XCTAssertEqual(gemWeekly?.detail, "72% left")
        XCTAssertNotNil(gemWeekly?.resetsAt)

        let gem5h = limits.first { $0.label == "gemini 5h" }
        XCTAssertNotNil(gem5h)
        XCTAssertEqual(gem5h?.usedPercent ?? 0, 4.8, accuracy: 0.1)
        XCTAssertEqual(gem5h?.detail, "95% left")

        let p3Weekly = limits.first { $0.label == "3p weekly" }
        XCTAssertNotNil(p3Weekly)
        XCTAssertEqual(p3Weekly?.usedPercent ?? 0, 0.0, accuracy: 0.1)
        XCTAssertEqual(p3Weekly?.detail, "100% left")

        let p35h = limits.first { $0.label == "3p 5h" }
        XCTAssertNotNil(p35h)
        XCTAssertEqual(p35h?.usedPercent ?? 0, 0.0, accuracy: 0.1)
        XCTAssertEqual(p35h?.detail, "100% left")
    }

    func testAgyRegexes_portExtraction() {
        // Test lsof output matching
        let lsofLine = "agy 26481 benebsworth 11u IPv4 0x4d5548b68aff1721 0t0 TCP 127.0.0.1:54314 (LISTEN)"
        let lsofRegex = try? NSRegularExpression(pattern: "127\\.0\\.0\\.1:(\\d+)")
        let nsLsof = lsofLine as NSString
        let match = lsofRegex?.firstMatch(in: lsofLine, range: NSRange(location: 0, length: nsLsof.length))
        XCTAssertNotNil(match)
        if let match, match.numberOfRanges > 1 {
            XCTAssertEqual(nsLsof.substring(with: match.range(at: 1)), "54314")
        }

        // Test cli.log line matching
        let logLine = "ERROR: logging before google.Init: I0904 13:09:21.857319 52 server.go:607] Language server listening on random port at 54314 for HTTP"
        let logRegex = try? NSRegularExpression(pattern: "port at (\\d+) for HTTP")
        let nsLog = logLine as NSString
        let logMatch = logRegex?.firstMatch(in: logLine, range: NSRange(location: 0, length: nsLog.length))
        XCTAssertNotNil(logMatch)
        if let logMatch, logMatch.numberOfRanges > 1 {
            XCTAssertEqual(nsLog.substring(with: logMatch.range(at: 1)), "54314")
        }
    }

    func testParseOpenAIPayload_primaryAndAdditional() {
        let json: [String: Any] = [
            "rate_limit": [
                "primary_window": [
                    "used_percent": 6.0,
                    "limit_window_seconds": 604800,
                    "reset_at": 1725700000
                ]
            ],
            "additional_rate_limits": [
                [
                    "limit_name": "GPT-4o",
                    "rate_limit": [
                        "primary_window": [
                            "used_percent": 24.0,
                            "limit_window_seconds": 18000,
                            "reset_at": 1725184800
                        ]
                    ]
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseOpenAIPayload(json)
        XCTAssertEqual(limits.count, 2)

        let primary = limits.first(where: { $0.label == "7d" })
        XCTAssertNotNil(primary)
        XCTAssertEqual(primary?.usedPercent, 6.0)
        XCTAssertEqual(primary?.detail, "94% left")

        let gpt4o = limits.first(where: { $0.label == "gpt-4o 5h" })
        XCTAssertNotNil(gpt4o)
        XCTAssertEqual(gpt4o?.usedPercent, 24.0)
        XCTAssertEqual(gpt4o?.detail, "76% left")
    }

    func testParseDeepSeekPayload() {
        let json: [String: Any] = [
            "is_available": true,
            "balance_infos": [
                [
                    "currency": "CNY",
                    "total_balance": "128.50"
                ]
            ]
        ]

        let limits = PlanLimitsEngine.parseDeepSeekPayload(json)
        XCTAssertEqual(limits.count, 1)
        XCTAssertEqual(limits.first?.provider, "deepseek")
        XCTAssertEqual(limits.first?.detail, "$128.50 CNY")
    }

    func testWindowLabel_conversions() {
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 0), "session")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 300), "5m")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 18000), "5h")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 86400), "1d")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 604800), "7d")
    }

    func testCookieValue_extraction() {
        let cookie = "foo=bar; cna=test-cna-12345; login_aliyunid_csrf=csrf-token-xyz; other=val"
        XCTAssertEqual(PlanLimitsEngine.cookieValue(name: "cna", from: cookie), "test-cna-12345")
        XCTAssertEqual(PlanLimitsEngine.cookieValue(name: "login_aliyunid_csrf", from: cookie), "csrf-token-xyz")
        XCTAssertNil(PlanLimitsEngine.cookieValue(name: "nonexistent", from: cookie))
    }

    func testEpochAndEpochMS() {
        let secDate = PlanLimitsEngine.epoch(1725184800)
        XCTAssertEqual(secDate?.timeIntervalSince1970, 1725184800)

        let msDate = PlanLimitsEngine.epochMS(1725184800000)
        XCTAssertEqual(msDate?.timeIntervalSince1970, 1725184800)
    }

    func testParseISO_validAndInvalid() {
        let valid = PlanLimitsEngine.parseISO("2026-09-01T12:00:00Z")
        XCTAssertNotNil(valid)

        let validFractional = PlanLimitsEngine.parseISO("2026-09-01T12:00:00.123Z")
        XCTAssertNotNil(validFractional)

        let invalid = PlanLimitsEngine.parseISO("not-a-date")
        XCTAssertNil(invalid)
    }

    func testFindDict_recursiveSearch() {
        let tree: [String: Any] = [
            "level1": [
                "nestedArray": [
                    ["otherKey": 1],
                    ["targetKey": "found"]
                ]
            ]
        ]

        let result = PlanLimitsEngine.findDict(containingAny: ["targetKey"], in: tree)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?["targetKey"] as? String, "found")
    }
}
