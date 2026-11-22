| Actor | checkout | expire | payment_succeeded | refund | ship |
| --- | --- | --- | --- | --- | --- |
| admin | — | — | — | ✓ role(admin), verified | ✓ role(admin) |
| customer ⚠ untrusted | ✓ owner | — | — | ✓ owner, verified | — |
| stripe | — | — | ✓ | — | — |
| system | — | ✓ | — | — | — |

✓ allowed, with the guards that must pass · — not allowed · ⚠ untrusted: its requests cannot be trusted

A transition allowed to several actors needs any one of them: a caller passes that row's guards.
