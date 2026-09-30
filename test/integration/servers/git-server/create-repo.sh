#!/bin/bash
GIT_DIR="/var/www/git"
REPO_NAME=$1

mkdir -p "${GIT_DIR}/${REPO_NAME}.git"
cd "${GIT_DIR}/${REPO_NAME}.git"

git init --bare &> /dev/null
touch git-daemon-export-ok
cp hooks/post-update.sample hooks/post-update 2>/dev/null || true
git config http.receivepack true
git config http.uploadpack true
git update-server-info
chown -Rf www-data:www-data "${GIT_DIR}/${REPO_NAME}.git"
git config --global --add safe.directory "${GIT_DIR}/${REPO_NAME}.git"
git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
echo "Git repository '${REPO_NAME}' created in ${GIT_DIR}/${REPO_NAME}.git"
