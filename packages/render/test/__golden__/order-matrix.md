| Actor | checkout | expire | payment_succeeded | refund | ship |
| --- | --- | --- | --- | --- | --- |
| admin | — | — | — | ✓ role(admin) | ✓ role(admin) |
| customer ⚠ untrusted | ✓ owner | — | — | — | — |
| stripe | — | — | ✓ | — | — |
| system | — | ✓ | — | — | — |

✓ allowed, with the guards that must pass · — not allowed · ⚠ untrusted: its requests cannot be trusted
