# DeepSeek gateway timeout

`createNativeGateway({ deepSeekTimeoutMs })` bounds the DeepSeek `/responses` request, including waiting for headers and consuming the response stream. The default is `120000` ms; the option must be an integer from `1` through `2147483647`.

If the deadline expires before the gateway sends response headers, it returns HTTP 504 with `DeepSeek request timed out`. If streaming has started, it closes the downstream stream and logs `deepseek_timeout` with `stream_started: true`. A client disconnect aborts the DeepSeek upstream request. The request is not retried. The timer and close listener are removed when the request finishes.

This timeout applies only to DeepSeek requests. GPT forwarding remains unchanged, and encrypted-payload relay calls continue to use `relayTimeoutMs`.
