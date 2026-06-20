#!/bin/bash
# Install gog automatically for the EC2 instances
curl -sL https://github.com/steipete/gogcli/releases/download/v0.13.0/gog_Linux_x86_64.tar.gz -o /tmp/gog.tar.gz || true
if [ -f /tmp/gog.tar.gz ]; then
  tar -xzf /tmp/gog.tar.gz -C /tmp
  if [ -f /tmp/gog ]; then
    chmod +x /tmp/gog
    mv /tmp/gog /usr/local/bin/gog
  fi
fi
