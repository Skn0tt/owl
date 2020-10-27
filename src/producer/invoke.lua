--[[
  Checks if a specified job exists and invokes it immediately

  Input:
    KEYS[1] job table + queue + id
    KEYS[2] queue

    ARGV[1] id
    ARGV[2] queue

  Output:
    0 found and invoked
    1 not found
]]

if redis.call("EXISTS", KEYS[1]) == 0 then
  return 1
end

redis.call("ZADD", KEYS[2], 0, ARGV[2] .. ":" .. ARGV[1])

-- publishes "scheduled" to "<queue>:<id>"
redis.call("PUBLISH", ARGV[2] .. ":" .. ARGV[1], "scheduled")
-- publishes "scheduled:<id>" to "<queue>"
redis.call("PUBLISH", ARGV[2], "scheduled" .. ":" .. ARGV[1])
-- publishes "<queue>:<id>" to "scheduled"
redis.call("PUBLISH", "scheduled", ARGV[2] .. ":" .. ARGV[1])

return 0