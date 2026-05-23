class Browser4agent < Formula
  desc "MCP server that reads browser tab content and controls the browser"
  homepage "https://github.com/__REPO__"
  version "__VERSION__"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/__REPO__/releases/download/__TAG__/browser4agent-aarch64-apple-darwin.tar.gz"
      sha256 "__MAC_ARM__"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/__REPO__/releases/download/__TAG__/browser4agent-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "__LINUX_X86__"
    end
  end

  def install
    bin.install "browser4agent"
  end

  def caveats
    <<~EOS
      Run `browser4agent` to register the native messaging host
      and configure your MCP clients (Codex / Claude / VS Code / Cursor / Zed).
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/browser4agent --version")
  end
end
