#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑苹果星球登录测试 - 带重试机制
如果登录失败，自动刷新验证码重试
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException
import time
import os

CHROME_DRIVER_PATH = "/usr/local/bin/chromedriver"
USERNAME = "fjdcml@126.com"
PASSWORD = "Cml366119"


def find_submit_button(driver):
    """查找登录提交按钮"""
    selectors = [
        (By.NAME, "wp-submit"),
        (By.NAME, "submit"),
        (By.ID, "wp-submit"),
        (By.ID, "submit"),
        (By.XPATH, "//button[@type='submit']"),
        (By.XPATH, "//input[@type='submit']"),
        (By.XPATH, "//*[contains(@class, 'button-primary')]"),
        (By.XPATH, "//*[contains(@class, 'submit')]"),
    ]
    
    for by, selector in selectors:
        try:
            elements = driver.find_elements(by, selector)
            for el in elements:
                if el and el.is_displayed():
                    return el
        except:
            continue
    return None


def refresh_captcha(driver):
    """刷新验证码"""
    try:
        # 尝试点击验证码图片刷新
        captcha_img = driver.find_element(By.XPATH, "//img[contains(@src, 'captcha')]")
        captcha_img.click()
        print("   🔄 已刷新验证码")
        time.sleep(1)
        return True
    except:
        # 如果找不到验证码图片，刷新整个页面
        driver.refresh()
        print("   🔄 已刷新页面")
        time.sleep(2)
        return True


def fill_login_form(driver, username, password, captcha):
    """填写登录表单"""
    try:
        # 用户名
        username_input = driver.find_element(By.ID, "user_login")
        username_input.clear()
        username_input.send_keys(username)
        
        # 密码
        password_input = driver.find_element(By.ID, "user_pass")
        password_input.clear()
        password_input.send_keys(password)
        
        # 验证码
        if captcha:
            try:
                captcha_input = driver.find_element(By.ID, "captcha_code")
                captcha_input.clear()
                captcha_input.send_keys(captcha)
            except:
                pass
        
        return True
    except Exception as e:
        print(f"   ❌ 填写表单失败: {e}")
        return False


def check_login_result(driver):
    """检查登录结果"""
    time.sleep(2)
    page_source = driver.page_source
    current_url = driver.current_url
    
    # 登录成功标志
    success_keywords = ["logout", "退出", "用户中心", "dashboard", "我的账户"]
    for keyword in success_keywords:
        if keyword.lower() in page_source.lower():
            return "success"
    
    # 登录失败标志
    error_keywords = ["验证码错误", "验证码不正确", "captcha error", "用户名或密码错误"]
    for keyword in error_keywords:
        if keyword.lower() in page_source.lower():
            return "error"
    
    # 如果URL变了且不包含login
    if "login" not in current_url and "wp-login" not in current_url:
        return "success"
    
    return "unknown"


def main():
    driver = None
    max_attempts = 5
    attempt = 0
    
    try:
        if not os.path.exists(CHROME_DRIVER_PATH):
            print(f"❌ 找不到 ChromeDriver")
            return

        print("🚀 启动 Chrome...")
        service = Service(executable_path=CHROME_DRIVER_PATH)
        options = Options()
        options.add_argument("--start-maximized")
        driver = webdriver.Chrome(service=service, options=options)

        while attempt < max_attempts:
            attempt += 1
            print(f"\n{'='*50}")
            print(f"🔄 第 {attempt} 次尝试登录")
            print('='*50)
            
            # 打开登录页面
            print("🌐 打开登录页面...")
            driver.get("https://heipg.cn/login")
            time.sleep(2)
            
            # 自动填写账号密码
            print("📧 填写账号密码...")
            try:
                username_input = driver.find_element(By.ID, "user_login")
                username_input.clear()
                username_input.send_keys(USERNAME)
                
                password_input = driver.find_element(By.ID, "user_pass")
                password_input.clear()
                password_input.send_keys(PASSWORD)
            except Exception as e:
                print(f"   ❌ 填写失败: {e}")
                continue
            
            # 手动输入验证码
            print("\n🔐 请在浏览器中查看验证码图片")
            print("   然后输入验证码（输入 q 退出）")
            captcha = input("验证码: ").strip()
            
            if captcha.lower() == 'q':
                print("👋 用户退出")
                break
            
            # 填写验证码
            if captcha:
                try:
                    captcha_input = driver.find_element(By.ID, "captcha_code")
                    captcha_input.clear()
                    captcha_input.send_keys(captcha)
                    print("✅ 验证码已填写")
                except:
                    print("⚠️ 找不到验证码输入框")
            
            # 点击提交按钮
            submit_btn = find_submit_button(driver)
            if submit_btn:
                print("✅ 点击提交按钮...")
                try:
                    submit_btn.click()
                except:
                    driver.execute_script("arguments[0].click();", submit_btn)
            else:
                print("❌ 找不到提交按钮")
                continue
            
            # 检查结果
            print("⏳ 等待结果...")
            result = check_login_result(driver)
            
            if result == "success":
                print("🎉 登录成功！")
                break
            elif result == "error":
                print("❌ 登录失败（验证码或账号密码错误）")
                print("   🔄 刷新验证码重试...")
                refresh_captcha(driver)
                continue
            else:
                print("⚠️ 登录状态不确定")
                print(f"   📌 当前URL: {driver.current_url}")
                # 让用户选择
                choice = input("   看起来登录成功了？(y/n): ").strip().lower()
                if choice == 'y':
                    print("🎉 登录成功！")
                    break
                else:
                    print("   🔄 重试...")
                    refresh_captcha(driver)
                    continue
        
        if attempt >= max_attempts:
            print(f"\n❌ 已达到最大尝试次数 ({max_attempts})，请检查账号密码或网络")

        print("\n⏳ 30秒后关闭浏览器...")
        time.sleep(30)

    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("👋 已关闭")


if __name__ == "__main__":
    main()
