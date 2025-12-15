import { Tabbar } from "@nutui/nutui-react-taro";
import {
  Cart,
  HeartFill,
  Heart,
  Hi,
  Home,
  User,
} from "@nutui/icons-react-taro";

const MyTabbar = () => {
  return (
    <Tabbar fixed>
      <Tabbar.Item title="首页" icon={<Home />} />
      <Tabbar.Item title="逛" icon={<Hi />} />
      <Tabbar.Item
        title="收藏"
        icon={(active) => (active ? <HeartFill /> : <Heart />)}
      />
      <Tabbar.Item title="购物车" icon={<Cart />} />
      <Tabbar.Item title="我的" icon={<User />} />
    </Tabbar>
  );
};

export default MyTabbar;
