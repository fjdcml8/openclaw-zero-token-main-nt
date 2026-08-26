from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
import time

# 配置
ACCOUNT = 'fjdcml@126.com'
PASSWORD = 'Cml366119'
SEARCH_KEYWORD = 'CAD'

# Chrome选项
chrome_options = Options()
chrome_options.add_argument('--no-sandbox')
chrome_options.add_argument('--disable-dev-shm-usage')

# 启动浏览器
driver = webdriver.Chrome(options=chrome_options)
wait = WebDriverWait(driver, 20)

try:
    # 打开黑苹果星球
    driver.get('https://heipg.cn')
    time.sleep(3)
    
    # 点击登录按钮
    login_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), '登录')]")))
    login_btn.click()
    time.sleep(2)
    
    # 填写账号
    email_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='email'], input[name='email'], input[placeholder*='邮箱'], input[placeholder*='账号']")))
    email_input.clear()
    email_input.send_keys(ACCOUNT)
    time.sleep(1)
    
    # 填写密码
    pwd_input = driver.find_element(By.CSS_SELECTOR, "input[type='password']")
    pwd_input.clear()
    pwd_input.send_keys(PASSWORD)
    time.sleep(1)
    
    # 点击安全登录按钮
    submit_btn = driver.find_element(By.XPATH, "//button[contains(text(), '安全登录')]")
    driver.execute_script("arguments[0].click();", submit_btn)
    time.sleep(5)
    
    # 搜索CAD
    search_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[name='s'], input[placeholder*='搜索'], .search-input")))
    search_input.clear()
    search_input.send_keys(SEARCH_KEYWORD)
    search_input.submit()
    
    print(f"✅ 已在黑苹果星球搜索: {SEARCH_KEYWORD}")
    print("浏览器保持打开，请查看搜索结果")
    
    # 保持浏览器打开
    while True:
        time.sleep(60)
        
except Exception as e:
    print(f"❌ 错误: {e}")
    driver.quit()
