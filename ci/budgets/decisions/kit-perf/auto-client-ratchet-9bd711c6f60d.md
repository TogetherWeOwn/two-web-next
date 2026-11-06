# Measured lower-only client ratchet

Source main: 9bd711c6f60dd3f9fa8f03e6e91acbf6acbbcba2

Raw step: 512 B. Gzip step: 256 B. Target = ceil(measured × 1.25 / step) × step. Lower only when current minus target is strictly greater than one step. File counts do not ratchet. Existing lower draft values never rise.

Undo: revert this PR's client budget changes and generated decision through a reviewed PR; automation never raises ceilings.

## Latest changes and headroom shortfalls

```json
{
  "changes": [
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events",
      "kind": "js",
      "limit": "maxRawBytes",
      "measured": 122453,
      "before": 154112,
      "after": 153088,
      "step": 512
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/e/[key]",
      "kind": "js",
      "limit": "maxRawBytes",
      "measured": 125677,
      "before": 171008,
      "after": 157184,
      "step": 512
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/e/[key]",
      "kind": "js",
      "limit": "maxGzipBytes",
      "measured": 48595,
      "before": 65024,
      "after": 60928,
      "step": 256
    }
  ],
  "shortfalls": [
    {
      "path": "ci/budgets/kit/client-js.json",
      "id": "aggregate",
      "kind": "js",
      "limit": "maxRawBytes",
      "ceiling": 261632,
      "target": 313344
    },
    {
      "path": "ci/budgets/kit/client-js.json",
      "id": "aggregate",
      "kind": "js",
      "limit": "maxGzipBytes",
      "ceiling": 104448,
      "target": 126720
    },
    {
      "path": "ci/budgets/kit/client-css.json",
      "id": "aggregate",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/about",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/activity-log",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events/[key]",
      "kind": "js",
      "limit": "maxRawBytes",
      "ceiling": 156160,
      "target": 156672
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events/[key]",
      "kind": "js",
      "limit": "maxGzipBytes",
      "ceiling": 60416,
      "target": 60672
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events/[key]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/events/new",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/featured",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/featured/[id]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/featured/new",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/join-attempts",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/admin/join-attempts/[id]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/auth/recover",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/e/[key]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/events/past",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/faq",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/hotzones",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/hotzones/[signal]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/join",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/leaderboards/members",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/members/[user]",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/privacy",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/profile",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    },
    {
      "path": "ci/budgets/kit-routes.json",
      "id": "/rules",
      "kind": "css",
      "limit": "maxRawBytes",
      "ceiling": 3072,
      "target": 3584
    }
  ]
}
```

## Machine-verifiable proposal

```json
{
  "version": 1,
  "base": {
    "ci/budgets/kit/client-js.json": {
      "$comment": "See ci/budgets/README.md; changing this ceiling needs a decision file in ci/budgets/decisions/kit-perf/.",
      "client": {
        "js": {
          "maxRawBytes": 261632,
          "maxGzipBytes": 104448,
          "maxFiles": 55
        }
      }
    },
    "ci/budgets/kit/client-css.json": {
      "$comment": "See ci/budgets/README.md; changing this ceiling needs a decision file in ci/budgets/decisions/kit-perf/.",
      "client": {
        "css": {
          "maxRawBytes": 3072,
          "maxGzipBytes": 1280,
          "maxFiles": 4
        }
      }
    },
    "ci/budgets/kit-routes.json": {
      "version": 1,
      "scope": "kit-immutable-route-closure-v1",
      "routes": {
        "/": {
          "js": {
            "maxRawBytes": 150528,
            "maxGzipBytes": 58624,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/[...path]": {
          "js": {
            "maxRawBytes": 0,
            "maxGzipBytes": 0,
            "maxFiles": 0
          },
          "css": {
            "maxRawBytes": 0,
            "maxGzipBytes": 0,
            "maxFiles": 0
          }
        },
        "/about": {
          "js": {
            "maxRawBytes": 139264,
            "maxGzipBytes": 54272,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin": {
          "js": {
            "maxRawBytes": 145920,
            "maxGzipBytes": 57344,
            "maxFiles": 21
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 3
          }
        },
        "/admin/activity-log": {
          "js": {
            "maxRawBytes": 146432,
            "maxGzipBytes": 57856,
            "maxFiles": 22
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/events": {
          "js": {
            "maxRawBytes": 154112,
            "maxGzipBytes": 60416,
            "maxFiles": 23
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/events/[key]": {
          "js": {
            "maxRawBytes": 156160,
            "maxGzipBytes": 60416,
            "maxFiles": 22
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/events/new": {
          "js": {
            "maxRawBytes": 153088,
            "maxGzipBytes": 59136,
            "maxFiles": 22
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/featured": {
          "js": {
            "maxRawBytes": 147456,
            "maxGzipBytes": 57856,
            "maxFiles": 21
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/featured/[id]": {
          "js": {
            "maxRawBytes": 148480,
            "maxGzipBytes": 58112,
            "maxFiles": 21
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/featured/new": {
          "js": {
            "maxRawBytes": 144896,
            "maxGzipBytes": 56576,
            "maxFiles": 21
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/join-attempts": {
          "js": {
            "maxRawBytes": 147456,
            "maxGzipBytes": 58368,
            "maxFiles": 22
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/admin/join-attempts/[id]": {
          "js": {
            "maxRawBytes": 145408,
            "maxGzipBytes": 57344,
            "maxFiles": 22
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/auth/recover": {
          "js": {
            "maxRawBytes": 137728,
            "maxGzipBytes": 53248,
            "maxFiles": 17
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/e/[key]": {
          "js": {
            "maxRawBytes": 171008,
            "maxGzipBytes": 65024,
            "maxFiles": 21
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/events": {
          "js": {
            "maxRawBytes": 0,
            "maxGzipBytes": 0,
            "maxFiles": 0
          },
          "css": {
            "maxRawBytes": 0,
            "maxGzipBytes": 0,
            "maxFiles": 0
          }
        },
        "/events/past": {
          "js": {
            "maxRawBytes": 143872,
            "maxGzipBytes": 55808,
            "maxFiles": 17
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/faq": {
          "js": {
            "maxRawBytes": 140288,
            "maxGzipBytes": 54528,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/hotzones": {
          "js": {
            "maxRawBytes": 142336,
            "maxGzipBytes": 55296,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/hotzones/[signal]": {
          "js": {
            "maxRawBytes": 141824,
            "maxGzipBytes": 55296,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/join": {
          "js": {
            "maxRawBytes": 141312,
            "maxGzipBytes": 54784,
            "maxFiles": 17
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/leaderboards/members": {
          "js": {
            "maxRawBytes": 144384,
            "maxGzipBytes": 56320,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/members/[user]": {
          "js": {
            "maxRawBytes": 159232,
            "maxGzipBytes": 60928,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/privacy": {
          "js": {
            "maxRawBytes": 138752,
            "maxGzipBytes": 54016,
            "maxFiles": 17
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/profile": {
          "js": {
            "maxRawBytes": 159232,
            "maxGzipBytes": 60928,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        },
        "/rules": {
          "js": {
            "maxRawBytes": 140288,
            "maxGzipBytes": 54528,
            "maxFiles": 18
          },
          "css": {
            "maxRawBytes": 3072,
            "maxGzipBytes": 1280,
            "maxFiles": 2
          }
        }
      }
    }
  },
  "history": [
    {
      "report": {
        "version": 1,
        "sha": "9bd711c6f60dd3f9fa8f03e6e91acbf6acbbcba2",
        "measurement": {
          "version": 1,
          "scope": "kit-immutable-route-closure-v1",
          "routes": {
            "/": {
              "js": {
                "rawBytes": 120068,
                "gzipBytes": 46721,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/BStF8G2r.js",
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/9.C3pGLCQ5.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/[...path]": {
              "js": {
                "rawBytes": 0,
                "gzipBytes": 0,
                "files": 0,
                "assets": []
              },
              "css": {
                "rawBytes": 0,
                "gzipBytes": 0,
                "files": 0,
                "assets": []
              }
            },
            "/about": {
              "js": {
                "rawBytes": 111160,
                "gzipBytes": 43231,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CAWKMROl.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/10.BWOyIBIi.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin": {
              "js": {
                "rawBytes": 116680,
                "gzipBytes": 45718,
                "files": 20,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/11.DMhIMLWs.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2861,
                "gzipBytes": 1019,
                "files": 2,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css",
                  "_app/immutable/assets/11.Csi5741p.css"
                ]
              }
            },
            "/admin/activity-log": {
              "js": {
                "rawBytes": 116946,
                "gzipBytes": 46108,
                "files": 21,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DhepHBkk.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/12.BU4WKL14.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/events": {
              "js": {
                "rawBytes": 122453,
                "gzipBytes": 48050,
                "files": 22,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/Bt7rafT7.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DhepHBkk.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/13.DeB-8VSv.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/events/[key]": {
              "js": {
                "rawBytes": 125143,
                "gzipBytes": 48406,
                "files": 21,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/BgXX7gJ-.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/14.BZMpShFv.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/events/new": {
              "js": {
                "rawBytes": 122081,
                "gzipBytes": 47143,
                "files": 21,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/BgXX7gJ-.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/15.6INIFuok.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/featured": {
              "js": {
                "rawBytes": 117873,
                "gzipBytes": 46235,
                "files": 20,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/16.3W3mGOT4.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/featured/[id]": {
              "js": {
                "rawBytes": 118676,
                "gzipBytes": 46357,
                "files": 20,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/17.CD6u6ORp.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/featured/new": {
              "js": {
                "rawBytes": 115596,
                "gzipBytes": 45236,
                "files": 20,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/18.CkIA3VNB.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/join-attempts": {
              "js": {
                "rawBytes": 117904,
                "gzipBytes": 46506,
                "files": 21,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/19.Dg7UnRwX.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js",
                  "_app/immutable/nodes/4.oMGVlsVT.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/admin/join-attempts/[id]": {
              "js": {
                "rawBytes": 116071,
                "gzipBytes": 45765,
                "files": 21,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/C35wguml.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/D0vSAJvT.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/2.C3aQTgOl.js",
                  "_app/immutable/nodes/20.B56Of49f.js",
                  "_app/immutable/nodes/3.DhxLLDl6.js",
                  "_app/immutable/nodes/4.oMGVlsVT.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/auth/recover": {
              "js": {
                "rawBytes": 110181,
                "gzipBytes": 42597,
                "files": 16,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/21.2hXD18Cd.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/e/[key]": {
              "js": {
                "rawBytes": 125677,
                "gzipBytes": 48595,
                "files": 20,
                "assets": [
                  "_app/immutable/chunks/BStF8G2r.js",
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/Bt7rafT7.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/22.DvDQivXx.js",
                  "_app/immutable/nodes/5.C3aQTgOl.js",
                  "_app/immutable/nodes/6.CYSCoKqW.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/events": {
              "js": {
                "rawBytes": 0,
                "gzipBytes": 0,
                "files": 0,
                "assets": []
              },
              "css": {
                "rawBytes": 0,
                "gzipBytes": 0,
                "files": 0,
                "assets": []
              }
            },
            "/events/past": {
              "js": {
                "rawBytes": 114825,
                "gzipBytes": 44612,
                "files": 16,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/23.BaKQuFnW.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/faq": {
              "js": {
                "rawBytes": 111840,
                "gzipBytes": 43590,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CAWKMROl.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/24.DJ512PJf.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/hotzones": {
              "js": {
                "rawBytes": 113647,
                "gzipBytes": 44204,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/25.V0Vigveq.js",
                  "_app/immutable/nodes/7.Cy1hswRU.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/hotzones/[signal]": {
              "js": {
                "rawBytes": 113133,
                "gzipBytes": 44065,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/26.b6HXXVWx.js",
                  "_app/immutable/nodes/7.Cy1hswRU.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/join": {
              "js": {
                "rawBytes": 112669,
                "gzipBytes": 43715,
                "files": 16,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/27.dWCu2Zaq.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/leaderboards/members": {
              "js": {
                "rawBytes": 115169,
                "gzipBytes": 44950,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/28.CK-nySEr.js",
                  "_app/immutable/nodes/8.Cn9M1tbh.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/members/[user]": {
              "js": {
                "rawBytes": 127240,
                "gzipBytes": 48591,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/BRaCRuEP.js",
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/29.CUORYvsB.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/privacy": {
              "js": {
                "rawBytes": 110910,
                "gzipBytes": 43044,
                "files": 16,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/30.CQa0dtUP.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/profile": {
              "js": {
                "rawBytes": 127240,
                "gzipBytes": 48591,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/BRaCRuEP.js",
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/31.CUORYvsB.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            },
            "/rules": {
              "js": {
                "rawBytes": 111941,
                "gzipBytes": 43593,
                "files": 17,
                "assets": [
                  "_app/immutable/chunks/B_BW6oyL.js",
                  "_app/immutable/chunks/CAWKMROl.js",
                  "_app/immutable/chunks/CRzLMJPS.js",
                  "_app/immutable/chunks/DHUB2FJE.js",
                  "_app/immutable/chunks/DY0AFrEW.js",
                  "_app/immutable/chunks/DkQxnBxn.js",
                  "_app/immutable/chunks/DwsryPXt.js",
                  "_app/immutable/chunks/NbxfrI0-.js",
                  "_app/immutable/chunks/YMTFD9ZE.js",
                  "_app/immutable/chunks/e_f2UB0l.js",
                  "_app/immutable/chunks/tec2J1RI.js",
                  "_app/immutable/entry/app.CCKHUMaI.js",
                  "_app/immutable/entry/payload.DSmR2FwN.js",
                  "_app/immutable/entry/start.E670ZmEc.js",
                  "_app/immutable/nodes/0.DhzpSJyE.js",
                  "_app/immutable/nodes/1.BtnZuZ9S.js",
                  "_app/immutable/nodes/32.D_CFKwgC.js"
                ]
              },
              "css": {
                "rawBytes": 2784,
                "gzipBytes": 927,
                "files": 1,
                "assets": [
                  "_app/immutable/assets/0.jsBMoaS5.css"
                ]
              }
            }
          },
          "aggregate": {
            "js": {
              "rawBytes": 250666,
              "gzipBytes": 101246,
              "files": 54,
              "assets": [
                "_app/immutable/chunks/BRaCRuEP.js",
                "_app/immutable/chunks/BStF8G2r.js",
                "_app/immutable/chunks/B_BW6oyL.js",
                "_app/immutable/chunks/BgXX7gJ-.js",
                "_app/immutable/chunks/Bt7rafT7.js",
                "_app/immutable/chunks/C35wguml.js",
                "_app/immutable/chunks/CAWKMROl.js",
                "_app/immutable/chunks/CRzLMJPS.js",
                "_app/immutable/chunks/D0vSAJvT.js",
                "_app/immutable/chunks/DHUB2FJE.js",
                "_app/immutable/chunks/DY0AFrEW.js",
                "_app/immutable/chunks/DhepHBkk.js",
                "_app/immutable/chunks/DkQxnBxn.js",
                "_app/immutable/chunks/DwsryPXt.js",
                "_app/immutable/chunks/NbxfrI0-.js",
                "_app/immutable/chunks/YMTFD9ZE.js",
                "_app/immutable/chunks/e_f2UB0l.js",
                "_app/immutable/chunks/tec2J1RI.js",
                "_app/immutable/entry/app.CCKHUMaI.js",
                "_app/immutable/entry/payload.DSmR2FwN.js",
                "_app/immutable/entry/start.E670ZmEc.js",
                "_app/immutable/nodes/0.DhzpSJyE.js",
                "_app/immutable/nodes/1.BtnZuZ9S.js",
                "_app/immutable/nodes/10.BWOyIBIi.js",
                "_app/immutable/nodes/11.DMhIMLWs.js",
                "_app/immutable/nodes/12.BU4WKL14.js",
                "_app/immutable/nodes/13.DeB-8VSv.js",
                "_app/immutable/nodes/14.BZMpShFv.js",
                "_app/immutable/nodes/15.6INIFuok.js",
                "_app/immutable/nodes/16.3W3mGOT4.js",
                "_app/immutable/nodes/17.CD6u6ORp.js",
                "_app/immutable/nodes/18.CkIA3VNB.js",
                "_app/immutable/nodes/19.Dg7UnRwX.js",
                "_app/immutable/nodes/2.C3aQTgOl.js",
                "_app/immutable/nodes/20.B56Of49f.js",
                "_app/immutable/nodes/21.2hXD18Cd.js",
                "_app/immutable/nodes/22.DvDQivXx.js",
                "_app/immutable/nodes/23.BaKQuFnW.js",
                "_app/immutable/nodes/24.DJ512PJf.js",
                "_app/immutable/nodes/25.V0Vigveq.js",
                "_app/immutable/nodes/26.b6HXXVWx.js",
                "_app/immutable/nodes/27.dWCu2Zaq.js",
                "_app/immutable/nodes/28.CK-nySEr.js",
                "_app/immutable/nodes/29.CUORYvsB.js",
                "_app/immutable/nodes/3.DhxLLDl6.js",
                "_app/immutable/nodes/30.CQa0dtUP.js",
                "_app/immutable/nodes/31.CUORYvsB.js",
                "_app/immutable/nodes/32.D_CFKwgC.js",
                "_app/immutable/nodes/4.oMGVlsVT.js",
                "_app/immutable/nodes/5.C3aQTgOl.js",
                "_app/immutable/nodes/6.CYSCoKqW.js",
                "_app/immutable/nodes/7.Cy1hswRU.js",
                "_app/immutable/nodes/8.Cn9M1tbh.js",
                "_app/immutable/nodes/9.C3pGLCQ5.js"
              ]
            },
            "css": {
              "rawBytes": 2861,
              "gzipBytes": 1019,
              "files": 2,
              "assets": [
                "_app/immutable/assets/0.jsBMoaS5.css",
                "_app/immutable/assets/11.Csi5741p.css"
              ]
            }
          },
          "exitCode": 0,
          "breaches": [],
          "headroomShortfalls": [
            "/ css",
            "/about css",
            "/admin css",
            "/admin/activity-log css",
            "/admin/events css",
            "/admin/events/[key] js",
            "/admin/events/[key] css",
            "/admin/events/new css",
            "/admin/featured css",
            "/admin/featured/[id] css",
            "/admin/featured/new css",
            "/admin/join-attempts css",
            "/admin/join-attempts/[id] css",
            "/auth/recover css",
            "/e/[key] css",
            "/events/past css",
            "/faq css",
            "/hotzones css",
            "/hotzones/[signal] css",
            "/join css",
            "/leaderboards/members css",
            "/members/[user] css",
            "/privacy css",
            "/profile css",
            "/rules css"
          ]
        }
      },
      "result": {
        "files": {
          "ci/budgets/kit/client-js.json": {
            "$comment": "See ci/budgets/README.md; changing this ceiling needs a decision file in ci/budgets/decisions/kit-perf/.",
            "client": {
              "js": {
                "maxRawBytes": 261632,
                "maxGzipBytes": 104448,
                "maxFiles": 55
              }
            }
          },
          "ci/budgets/kit/client-css.json": {
            "$comment": "See ci/budgets/README.md; changing this ceiling needs a decision file in ci/budgets/decisions/kit-perf/.",
            "client": {
              "css": {
                "maxRawBytes": 3072,
                "maxGzipBytes": 1280,
                "maxFiles": 4
              }
            }
          },
          "ci/budgets/kit-routes.json": {
            "version": 1,
            "scope": "kit-immutable-route-closure-v1",
            "routes": {
              "/": {
                "js": {
                  "maxRawBytes": 150528,
                  "maxGzipBytes": 58624,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/[...path]": {
                "js": {
                  "maxRawBytes": 0,
                  "maxGzipBytes": 0,
                  "maxFiles": 0
                },
                "css": {
                  "maxRawBytes": 0,
                  "maxGzipBytes": 0,
                  "maxFiles": 0
                }
              },
              "/about": {
                "js": {
                  "maxRawBytes": 139264,
                  "maxGzipBytes": 54272,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin": {
                "js": {
                  "maxRawBytes": 145920,
                  "maxGzipBytes": 57344,
                  "maxFiles": 21
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 3
                }
              },
              "/admin/activity-log": {
                "js": {
                  "maxRawBytes": 146432,
                  "maxGzipBytes": 57856,
                  "maxFiles": 22
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/events": {
                "js": {
                  "maxRawBytes": 153088,
                  "maxGzipBytes": 60416,
                  "maxFiles": 23
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/events/[key]": {
                "js": {
                  "maxRawBytes": 156160,
                  "maxGzipBytes": 60416,
                  "maxFiles": 22
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/events/new": {
                "js": {
                  "maxRawBytes": 153088,
                  "maxGzipBytes": 59136,
                  "maxFiles": 22
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/featured": {
                "js": {
                  "maxRawBytes": 147456,
                  "maxGzipBytes": 57856,
                  "maxFiles": 21
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/featured/[id]": {
                "js": {
                  "maxRawBytes": 148480,
                  "maxGzipBytes": 58112,
                  "maxFiles": 21
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/featured/new": {
                "js": {
                  "maxRawBytes": 144896,
                  "maxGzipBytes": 56576,
                  "maxFiles": 21
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/join-attempts": {
                "js": {
                  "maxRawBytes": 147456,
                  "maxGzipBytes": 58368,
                  "maxFiles": 22
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/admin/join-attempts/[id]": {
                "js": {
                  "maxRawBytes": 145408,
                  "maxGzipBytes": 57344,
                  "maxFiles": 22
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/auth/recover": {
                "js": {
                  "maxRawBytes": 137728,
                  "maxGzipBytes": 53248,
                  "maxFiles": 17
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/e/[key]": {
                "js": {
                  "maxRawBytes": 157184,
                  "maxGzipBytes": 60928,
                  "maxFiles": 21
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/events": {
                "js": {
                  "maxRawBytes": 0,
                  "maxGzipBytes": 0,
                  "maxFiles": 0
                },
                "css": {
                  "maxRawBytes": 0,
                  "maxGzipBytes": 0,
                  "maxFiles": 0
                }
              },
              "/events/past": {
                "js": {
                  "maxRawBytes": 143872,
                  "maxGzipBytes": 55808,
                  "maxFiles": 17
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/faq": {
                "js": {
                  "maxRawBytes": 140288,
                  "maxGzipBytes": 54528,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/hotzones": {
                "js": {
                  "maxRawBytes": 142336,
                  "maxGzipBytes": 55296,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/hotzones/[signal]": {
                "js": {
                  "maxRawBytes": 141824,
                  "maxGzipBytes": 55296,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/join": {
                "js": {
                  "maxRawBytes": 141312,
                  "maxGzipBytes": 54784,
                  "maxFiles": 17
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/leaderboards/members": {
                "js": {
                  "maxRawBytes": 144384,
                  "maxGzipBytes": 56320,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/members/[user]": {
                "js": {
                  "maxRawBytes": 159232,
                  "maxGzipBytes": 60928,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/privacy": {
                "js": {
                  "maxRawBytes": 138752,
                  "maxGzipBytes": 54016,
                  "maxFiles": 17
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/profile": {
                "js": {
                  "maxRawBytes": 159232,
                  "maxGzipBytes": 60928,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              },
              "/rules": {
                "js": {
                  "maxRawBytes": 140288,
                  "maxGzipBytes": 54528,
                  "maxFiles": 18
                },
                "css": {
                  "maxRawBytes": 3072,
                  "maxGzipBytes": 1280,
                  "maxFiles": 2
                }
              }
            }
          }
        },
        "changes": [
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events",
            "kind": "js",
            "limit": "maxRawBytes",
            "measured": 122453,
            "before": 154112,
            "after": 153088,
            "step": 512
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/e/[key]",
            "kind": "js",
            "limit": "maxRawBytes",
            "measured": 125677,
            "before": 171008,
            "after": 157184,
            "step": 512
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/e/[key]",
            "kind": "js",
            "limit": "maxGzipBytes",
            "measured": 48595,
            "before": 65024,
            "after": 60928,
            "step": 256
          }
        ],
        "shortfalls": [
          {
            "path": "ci/budgets/kit/client-js.json",
            "id": "aggregate",
            "kind": "js",
            "limit": "maxRawBytes",
            "ceiling": 261632,
            "target": 313344
          },
          {
            "path": "ci/budgets/kit/client-js.json",
            "id": "aggregate",
            "kind": "js",
            "limit": "maxGzipBytes",
            "ceiling": 104448,
            "target": 126720
          },
          {
            "path": "ci/budgets/kit/client-css.json",
            "id": "aggregate",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/about",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/activity-log",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events/[key]",
            "kind": "js",
            "limit": "maxRawBytes",
            "ceiling": 156160,
            "target": 156672
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events/[key]",
            "kind": "js",
            "limit": "maxGzipBytes",
            "ceiling": 60416,
            "target": 60672
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events/[key]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/events/new",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/featured",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/featured/[id]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/featured/new",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/join-attempts",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/admin/join-attempts/[id]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/auth/recover",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/e/[key]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/events/past",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/faq",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/hotzones",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/hotzones/[signal]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/join",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/leaderboards/members",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/members/[user]",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/privacy",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/profile",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          },
          {
            "path": "ci/budgets/kit-routes.json",
            "id": "/rules",
            "kind": "css",
            "limit": "maxRawBytes",
            "ceiling": 3072,
            "target": 3584
          }
        ]
      }
    }
  ]
}
```
