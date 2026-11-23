import { useEffect, useState, type FormEvent } from 'react'
import type { MarketAuthStatus } from '../../services/marketAuth.ts'
import {
  marketLogin,
  marketRegister,
  marketSendCode,
} from '../../services/marketAuth.ts'
import { useSettings } from '../../services/settings.ts'
import type { MarketPluginView } from '../../services/market.ts'
import { Modal } from '../base/Modal.tsx'
import styles from './MarketAuthModal.module.css'

type Props = {
  open: boolean
  plugin: MarketPluginView | null
  onClose: () => void
  onLoggedIn: (status: MarketAuthStatus) => void
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const MarketAuthModal = ({ open, plugin, onClose, onLoggedIn }: Props) => {
  const settings = useSettings()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode('login')
    setError('')
    setNotice('')
  }, [open, plugin?.id])

  if (!plugin) return null

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'login') {
        const status = await marketLogin(
          plugin.id,
          username.trim(),
          password,
          settings.customGatewayOrigin
        )
        onLoggedIn(status)
        onClose()
        return
      }
      const status = await marketRegister(
        plugin.id,
        { email: email.trim(), code: code.trim(), username: username.trim(), password },
        settings.customGatewayOrigin
      )
      if (status.loggedIn) {
        onLoggedIn(status)
        onClose()
        return
      }
      setMode('login')
      setNotice('注册成功，请使用刚才的账号登录。')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSendCode = async () => {
    setSendingCode(true)
    setError('')
    setNotice('')
    try {
      await marketSendCode(plugin.id, email.trim(), settings.customGatewayOrigin)
      setNotice('验证码已发送，请查收邮箱。')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSendingCode(false)
    }
  }

  return (
    <Modal open={open} title={`登录 ${plugin.name}`} size="sm" onClose={onClose}>
      <div className={styles.page}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={mode === 'login' ? styles.tabActive : styles.tab}
            onClick={() => setMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? styles.tabActive : styles.tab}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          {mode === 'register' ? (
            <>
              <label className={styles.field}>
                <span>邮箱</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="用于接收验证码"
                  autoComplete="email"
                  required
                />
              </label>
              <p className={styles.fieldHint}>
                填写邮箱后「发送验证码」才会变为可点；像素酒馆对邮箱域名有白名单，提示不允许时请换用其他邮箱。
              </p>
              <label className={styles.field}>
                <span>验证码</span>
                <div className={styles.codeRow}>
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="邮箱验证码"
                    inputMode="numeric"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => void handleSendCode()}
                    disabled={sendingCode || email.trim() === ''}
                  >
                    {sendingCode ? '发送中…' : '发送验证码'}
                  </button>
                </div>
              </label>
            </>
          ) : null}

          <label className={styles.field}>
            <span>{mode === 'login' ? '用户名或邮箱' : '用户名'}</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className={styles.field}>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>

          {error ? <div className={styles.error}>{error}</div> : null}
          {notice ? <div className={styles.notice}>{notice}</div> : null}

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        <p className={styles.hint}>
          登录信息只保存在本机，之后浏览和下载会自动复用该会话，不需要每次重新登录。
        </p>
      </div>
    </Modal>
  )
}
