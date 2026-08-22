-- 用当前登录用户连维护库 postgres。
-- 无目标数据库则创建；已存在则跳过。

SELECT format('CREATE DATABASE %I', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')
\gexec
