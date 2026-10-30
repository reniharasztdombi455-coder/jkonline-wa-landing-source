-- Re-seed the analytics test link after queue concurrency tests.
-- This only runs against the isolated local D1 configured by the CI workflow.
INSERT OR REPLACE INTO landing_links
  (id,slug,name,phone,message,source,agent,campaign,ad,enabled)
VALUES
  (1,'queue-test','Queue local test','15551234567',
   'Hello, my code is TEST-AB/-1.','ci','test-agent','queue-ci','fixture',1);
