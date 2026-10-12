"use client";

/* 全局错误边界：单个页面崩溃时给出可恢复的友好界面（重载/重试/去总览），
 * 而不是 Next 默认的裸 "This page couldn't load"，降低"坏了"的观感并保住其余功能。 */

import { Component, type ReactNode } from "react";

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 类组件的 state 字段初始化被 react-compiler 系新规则误报（这里没有 effect，也不会有级联渲染）
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  render() {
    if (this.state.err) {
      return (
        <div className="mx-auto max-w-md rounded-2xl border border-border bg-surface p-6 text-center">
          <p className="text-base font-bold text-ink">这一页出了点问题</p>
          <p className="mt-2 break-words text-[12.5px] leading-relaxed text-ink-dim">
            {this.state.err.message || "未知错误"}
          </p>
          <p className="mt-1 text-[12px] text-ink-dim/80">你的数据是安全的（云端有备份）。可以先重试或重载。</p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              onClick={() => this.setState({ err: null })}
              className="cursor-pointer rounded-xl bg-[#1a1a1a] px-4 py-2 text-[13px] text-white transition hover:bg-black/80"
            >
              重试
            </button>
            <button
              onClick={() => window.location.reload()}
              className="cursor-pointer rounded-xl border border-border px-4 py-2 text-[13px] text-ink transition hover:bg-black/[0.04]"
            >
              重新加载
            </button>
            <button
              onClick={() => window.location.assign("/")}
              className="cursor-pointer rounded-xl border border-border px-4 py-2 text-[13px] text-ink transition hover:bg-black/[0.04]"
            >
              回总览
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
