import test from "node:test";
import assert from "node:assert/strict";
import { EdgeLifeline } from "../src/edge/lifeline.ts";
import { parseConfig } from "../src/utils/config.ts";
import { sleep, waitFor } from "./helpers.ts";

// `.invalid` never resolves (RFC 2606): the same ENOTFOUND/EAI_AGAIN an Edge gets from a container whose
// /etc/resolv.conf was copied before the host had DNS.
function edge(hubUrl: string, dnsExitAfter: string) {
    const config = parseConfig([], {
        HUB_URL: hubUrl,
        TOKEN: "fsc_edge_test:edg_test",
        RECONNECT_INTERVAL: "0.05",
        MAX_RECONNECT_INTERVAL: "0.1",
        DNS_EXIT_AFTER: dnsExitAfter,
    });
    const exits: number[] = [];
    const lifeline = new EdgeLifeline({ config, exit: (code) => exits.push(code) });
    return { lifeline, exits };
}

test("edge: exits for a restart when the Hub hostname stays unresolvable", async () => {
    const { lifeline, exits } = edge("ws://hub.invalid", "0.3");
    lifeline.start();
    try {
        await waitFor(() => exits.length > 0, 5000);
        assert.deepEqual(exits, [1]);
        await sleep(300);
        assert.deepEqual(exits, [1], "no further dials once it exited");
    } finally {
        await lifeline.stop();
    }
});

test("edge: DNS_EXIT_AFTER=0 keeps retrying forever", async () => {
    const { lifeline, exits } = edge("ws://hub.invalid", "0");
    lifeline.start();
    try {
        await sleep(800);
        assert.deepEqual(exits, []);
    } finally {
        await lifeline.stop();
    }
});

test("edge: a Hub that resolves but refuses connections never triggers the exit", async () => {
    const { lifeline, exits } = edge("ws://127.0.0.1:1", "0.2");
    lifeline.start();
    try {
        await sleep(800);
        assert.deepEqual(exits, []);
    } finally {
        await lifeline.stop();
    }
});
