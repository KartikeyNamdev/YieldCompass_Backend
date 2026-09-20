// the faucet has its own strict rate limit in production; tests make many calls
process.env.FAUCET_RATE_PER_MIN = "1000"
