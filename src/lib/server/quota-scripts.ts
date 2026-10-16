// Redis TIME is authoritative across serverless instances. All windows are
// checked before any reservation is written. No public route accepts costs.
export const QUOTA_RESERVE_LUA = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local spec=cjson.decode(ARGV[1])
local mode=ARGV[2]
local id=ARGV[3]
local fingerprint=ARGV[4]
if mode=='reserve' then
  local prior=redis.call('GET',KEYS[1])
  if prior then
    local record=cjson.decode(prior)
    if record.fingerprint~=fingerprint then return cjson.encode({kind='conflict'}) end
    return cjson.encode({kind='duplicate',status=record.status})
  end
end
local windows={}
local allowed=true
local retryAt=now
for i,w in ipairs(spec) do
  local key=KEYS[i+1]
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now-w.windowMs)
  local values=redis.call('ZRANGE',key,0,-1,'WITHSCORES')
  local used=0
  local reserved=0
  for j=1,#values,2 do
    local state,cost=string.match(values[j],'|([ru])|(%d+)$')
    if state=='r' then reserved=reserved+tonumber(cost) else used=used+tonumber(cost) end
  end
  local nextAt=now
  if used+reserved+w.cost>w.limit then
    allowed=false
    local remainder=used+reserved
    for j=1,#values,2 do
      local cost=tonumber(string.match(values[j],'|(%d+)$'))
      remainder=remainder-cost
      nextAt=tonumber(values[j+1])+w.windowMs+1
      if remainder+w.cost<=w.limit then break end
    end
    if w.cost>w.limit then nextAt=now+w.windowMs end
    retryAt=math.max(retryAt,nextAt)
  end
  windows[i]={resource=w.resource,windowSeconds=w.windowMs/1000,limit=w.limit,used=used,reserved=reserved,remaining=math.max(0,w.limit-used-reserved),retryAt=nextAt>now and nextAt or 0}
end
if mode=='reserve' and allowed then
  local record={fingerprint=fingerprint,status='reserved',timestamp=now,windows=spec,keys={},id=id}
  for i,w in ipairs(spec) do
    local key=KEYS[i+1]
    redis.call('ZADD',key,now,id..'|r|'..w.cost)
    redis.call('PEXPIRE',key,w.windowMs+60000)
    record.keys[i]=key
  end
  redis.call('SET',KEYS[1],cjson.encode(record),'EX',90000)
end
return cjson.encode({kind=allowed and (mode=='inspect' and 'snapshot' or 'acquired') or 'denied',windows=windows,now=now,retryAt=allowed and 0 or retryAt})
`;

export const QUOTA_SETTLE_LUA = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 'missing' end
local record=cjson.decode(raw)
if record.fingerprint~=ARGV[1] then return 'conflict' end
if record.status~='reserved' then return 'duplicate' end
local actual=cjson.decode(ARGV[2])
for i,w in ipairs(record.windows) do
  local cost=actual[w.resource]
  if not cost or cost<0 or cost>w.cost or cost~=math.floor(cost) then return 'invalid' end
end
for i,w in ipairs(record.windows) do
  local key=record.keys[i]
  local member=record.id..'|r|'..w.cost
  if redis.call('ZSCORE',key,member) then
    redis.call('ZREM',key,member)
    local cost=actual[w.resource]
    if cost>0 then redis.call('ZADD',key,record.timestamp,record.id..'|u|'..cost) end
  end
end
record.status='settled'
redis.call('SET',KEYS[1],cjson.encode(record),'KEEPTTL')
return 'settled'
`;

export const RATE_LIMIT_LUA = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local limits=cjson.decode(ARGV[1])
local retryAt=0
for i,v in ipairs(limits) do
  redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-v.windowMs)
  if redis.call('ZCARD',KEYS[i])>=v.limit then
    local oldest=redis.call('ZRANGE',KEYS[i],0,0,'WITHSCORES')
    retryAt=math.max(retryAt,tonumber(oldest[2])+v.windowMs+1)
  end
end
if retryAt>0 then return retryAt end
for i,v in ipairs(limits) do
  redis.call('ZADD',KEYS[i],now,ARGV[2])
  redis.call('PEXPIRE',KEYS[i],v.windowMs+60000)
end
return 0
`;
