// Reviewed false positives in immutable historical Git blobs. Snapshot scans never use this baseline.
export const PUBLIC_HISTORY_BASELINE = [
  {
    "blob": "f9a3852cc5073d80c4dbec8a0b2ce36896eb92af",
    "file": "ci/run-public-gate.sh",
    "findings": [
      {
        "kind": "personal-absolute-path",
        "line": 29
      }
    ],
    "reason": "Standard runner directory in an explanatory CI comment."
  },
  {
    "blob": "3caa221b72d19d22cc57479bc47b06e86a0eb655",
    "file": "packages/agentkit-harness-node/test/native-browser-workspace-server.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 51
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "8446c5d56020648038fe1f8e2fa5dae0ef9cb087",
    "file": "packages/agentkit-harness-node/test/native-model.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 1520
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "b9747c1aedf509c780f68e2e9700baa3f79a597a",
    "file": "packages/agentkit-harness-node/test/native-web-tools.test.mjs",
    "findings": [
      {
        "kind": "private-network-address",
        "line": 152
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "2edae2de7260b17d5f72735947d9bd735ea2b5d7",
    "file": "packages/agentkit-harness/test/native-browser-workspace-server.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 50
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "bad43c9730affe1287d2f60f3edfe4e957c351b5",
    "file": "packages/agentkit-harness/test/native-model.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 1223
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "a02e7897c80f287610155d8b97a999a92f7ff69a",
    "file": "packages/agentkit-harness/test/native-web-tools.test.mjs",
    "findings": [
      {
        "kind": "private-network-address",
        "line": 152
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "a42b2a3267828a299ad006f7b3f862ba6992d300",
    "file": "tests/native-a2a-agent-card.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 281
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "0b2b343b9491dd03fb4e630eb1ff44464e8dd467",
    "file": "tests/native-dsh-web.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 151
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "fad7e866db1ce96e4ca2fe3632a63e562c4c86c5",
    "file": "tests/native-e2b-host.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 133
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "3b65fbea3db7d6498790e31947d1a813a6e4929a",
    "file": "tests/native-e2b-sdk-transport.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 150
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "1754a8763cf1c63a2712967730f209641839ac64",
    "file": "tests/native-skill-loader.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 100
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "9beb284de341094ac0ebb68e8db37e36cfd1b27e",
    "file": "tests/native-skill-service.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 334
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "cda83dc2f1f61d6443853e5c4cbf390a3e9dadb6",
    "file": "tests/skill-github-archive-source.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 42
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "49a62ee3ab6412ce73b49362f8df9f0077a49d9d",
    "file": "packages/agentkit-harness-node/test/native-browser-workspace-server.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 50
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "ce6cf7930445a61de16dfbdd747766d236c99538",
    "file": "packages/agentkit-harness-node/test/native-model.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 1223
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "31098485816f43bf43bdb7ca3880dfd3f4fdf44a",
    "file": "packages/agentkit-harness/test/native-model.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 1223
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  },
  {
    "blob": "e7b9b2126e53fe24cb4e70956c87ef2c5336cc71",
    "file": "tests/native-dsh-web.test.mjs",
    "findings": [
      {
        "kind": "embedded-url-credential",
        "line": 151
      }
    ],
    "reason": "Synthetic negative fixtures for rejecting credential-bearing URLs or private network fetches."
  }
];
