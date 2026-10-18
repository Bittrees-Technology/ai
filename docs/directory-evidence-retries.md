# Directory evidence retries

Failed catalogue validations enter the same durable follow-up queue as discoveries. The latest failed batch from older versions is recovered once when an enabled workflow starts. Repeated retry requests do not reset the existing three-attempt backoff or duplicate work. Evidence failures remain unverified.

The local model selects quoted evidence from bounded literal excerpts of the fetched source. The independent exact-source validator remains mandatory. One correction attempt is allowed for invalid output; every receipt records the attempt count and rejected-output reason.

A listing may supply an optional reviewed `research_url` (for example its official documentation) when its primary page cannot be read. This is public evidence only, not a product link or verification grant. Retries reload the current listing by ID and retain its comparison context. HTTPS, exact-host redirect checks, public-address checks and response size limits still apply. No runtime host wildcard or automatic redirect trust is added.

The authenticated local retry endpoint is `POST /v1/research/directory/retry`. It queues the latest failed validation batch and preserves paused state and exhausted retry budgets. The Workflows directory view provides the same control. Saved assessments do not publish listing changes; workflow sync shares only the existing bounded process metadata.
