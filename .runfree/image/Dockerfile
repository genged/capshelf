ARG RUNFREE_BASE_IMAGE=runfree/agent-base:missing-runfree-base-image-build-arg
FROM ${RUNFREE_BASE_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      file \
      procps \
      ruby-full \
      unzip \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/linuxbrew/.linuxbrew \
 && chown -R agent:agent /home/linuxbrew

USER agent
ENV HOMEBREW_NO_ANALYTICS=1 \
    HOMEBREW_NO_AUTO_UPDATE=1 \
    PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/agent/.bun/bin:${PATH}"

RUN NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
RUN curl -fsSL https://bun.sh/install | bash
