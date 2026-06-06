# Cross-compile the Go `bareclaw` binary into prebuilds/<os>-<arch>/, matching
# the `#bareclaw` import map in package.json (Node-style os/arch names).

GO_PKG := ./cmd
OUT    := prebuilds

# Directory names mirror package.json's imports (os: darwin/linux/win32).
DIRS := darwin-x64 darwin-arm64 linux-x64 linux-arm64 win32-x64 win32-arm64

.DEFAULT_GOAL := build
.PHONY: build clean $(addprefix build-,$(DIRS))

build: $(addprefix build-,$(DIRS))

# build-target,<dir>,<GOOS>,<GOARCH>,<binary>
define build-target
build-$(1):
	GOOS=$(2) GOARCH=$(3) go build -C go -o ../$(OUT)/$(1)/$(4) $(GO_PKG)
	@echo "Built $(OUT)/$(1)/$(4)"
endef

$(eval $(call build-target,darwin-x64,darwin,amd64,bareclaw))
$(eval $(call build-target,darwin-arm64,darwin,arm64,bareclaw))
$(eval $(call build-target,linux-x64,linux,amd64,bareclaw))
$(eval $(call build-target,linux-arm64,linux,arm64,bareclaw))
$(eval $(call build-target,win32-x64,windows,amd64,bareclaw.exe))
$(eval $(call build-target,win32-arm64,windows,arm64,bareclaw.exe))

clean:
	rm -rf $(OUT)
