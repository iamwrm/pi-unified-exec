/**
 * Unit tests for the numeric-signal → SIG* name mapping in src/pty.ts.
 *
 * Regression: the map used to be a hand-picked 6-entry table, so tty-mode
 * children killed by SIGSEGV / SIGPIPE / SIGUSR1 were reported as exit_code=0.
 * The map is now built from the platform's full `os.constants.signals` table.
 */

import { strict as assert } from "node:assert";
import { constants } from "node:os";
import { describe, it } from "node:test";
import { signalNameFromNumber } from "../src/pty.ts";

describe("signalNameFromNumber", () => {
	it("maps common signals from the platform table", () => {
		assert.equal(signalNameFromNumber(constants.signals.SIGTERM), "SIGTERM");
		assert.equal(signalNameFromNumber(constants.signals.SIGKILL), "SIGKILL");
		assert.equal(signalNameFromNumber(constants.signals.SIGINT), "SIGINT");
		assert.equal(signalNameFromNumber(constants.signals.SIGHUP), "SIGHUP");
	});

	it("maps crash/IO signals that the old hand-picked table missed", () => {
		assert.equal(signalNameFromNumber(constants.signals.SIGSEGV), "SIGSEGV");
		assert.equal(signalNameFromNumber(constants.signals.SIGPIPE), "SIGPIPE");
		assert.equal(signalNameFromNumber(constants.signals.SIGUSR1), "SIGUSR1");
		assert.equal(signalNameFromNumber(constants.signals.SIGUSR2), "SIGUSR2");
	});

	it("returns null for unknown numbers", () => {
		assert.equal(signalNameFromNumber(0), null);
		assert.equal(signalNameFromNumber(999), null);
	});
});
