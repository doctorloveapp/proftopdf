# Workspace rules

- The user alone runs every Git command. Never run Git, including read-only commands, commit, push, checkout or Git-based deployment helpers.
- Direct-to-Cloud workflow: local compilation and code checks are allowed. Do not start localhost browser sessions or local preview servers. Functional browser checks happen on https://proftopdf.velodent.eu after the user pushes and Vercel deploys.
- Never print credentials or the contents of .env files. Load them in process memory only. Keep Documenti/ and every .env variant ignored; config/environment.example is the safe, tracked template.
- All external services must remain on their free plans without a mandatory credit card. Never enable paid billing or automatic paid fallbacks.
- Keep the operational plan updated with evidence and distinguish model discovery, synthetic API probes, actual audio tests, local builds and deployed tests.
