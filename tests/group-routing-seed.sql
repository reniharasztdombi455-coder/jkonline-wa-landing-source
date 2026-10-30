INSERT OR REPLACE INTO landing_links(id,slug,name,phone,message,contact_mode,routing_mode,source,agent,campaign,ad,enabled)
VALUES(3,'group-test','Group local test','','Hello, your code is TEST-AB/-1.','code_only','group','ci','group-test','group-ci','fixture',1);
INSERT INTO wa_groups(id,label,invite_url,max_members,sort_order,enabled)
VALUES
 (1,'Group A','https://chat.whatsapp.com/GROUP_A_TEST',2,1,1),
 (2,'Group B','https://chat.whatsapp.com/GROUP_B_TEST',2,2,1);
