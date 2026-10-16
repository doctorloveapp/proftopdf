export const CACHE_RESULT_LUA = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-900)
if not redis.call('ZSCORE',KEYS[1],KEYS[2]) and redis.call('ZCARD',KEYS[1])>=500 then return 0 end
redis.call('SET',KEYS[2],ARGV[1],'EX',900)
redis.call('ZADD',KEYS[1],now,KEYS[2])
redis.call('EXPIRE',KEYS[1],901)
return 1
`;
