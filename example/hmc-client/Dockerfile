# A client that renders: Java 25 for HeadlessMc, Xvfb and Mesa's software OpenGL for the game
FROM eclipse-temurin:25-jdk@sha256:b8705e936964c228dfce359e63dbf08f6c69cb380ed1d576b1f6b1064f15567d
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri libxrandr2 libxcursor1 libxi6 libxxf86vm1 \
    && rm -rf /var/lib/apt/lists/*
