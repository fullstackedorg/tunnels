#!/bin/bash
set -e

/home/setup.sh

exec /usr/sbin/apache2ctl -D FOREGROUND
