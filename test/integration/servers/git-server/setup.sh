#!/bin/bash
rm -rf /var/www/git
mkdir -p /var/www/git

/usr/bin/mkrepo empty
/usr/bin/mkrepo test

cd /tmp
rm -rf /tmp/seed
mkdir -p /tmp/seed
cd /tmp/seed
git init -b main
git config user.email test@testing.com
git config user.name "test user"
echo "test file" > test.txt
git add test.txt
git commit -m "initial commit"
git push /var/www/git/test.git main
rm -rf /tmp/seed

chown -Rf www-data:www-data /var/www/git
cd /var/www/git/test.git && git update-server-info
